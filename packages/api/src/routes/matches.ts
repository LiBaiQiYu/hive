import { Hono } from 'hono';
import { z } from 'zod';
import { ApiError, newId } from '@hive/shared';
import type { AppEnv, Env } from '../env';
import { requireAdmin } from '../guard';
import { computePositionFit, CONFLICT_THRESHOLD, type BalanceResult } from '../algorithms/team-balancing';
import { MATCH_SIZE, TEAM_SIZE } from '../services/roster';
import { attachPositions, generateMatchLineup, publishMatch } from '../services/lineup';
import { recomputeEventRatings } from '../services/rating';
import { loadEvent } from './events';

export const adminMatchRoutes = new Hono<AppEnv>();
export const publicMatchRoutes = new Hono<AppEnv>();

const generateSchema = z.object({
  eventId: z.string().min(1),
  matchNo: z.number().int().min(1).max(10).optional(),
  seed: z.number().int().min(0).max(1_000_000).optional(),
  /** 管理员手动指定参赛者；顺序即正选优先级。不给则按评分自动取 10 人 */
  playerIds: z.array(z.string().min(1)).length(MATCH_SIZE).optional(),
});

async function loadLineup(env: Env, matchId: string) {
  const match = await env.DB.prepare(
    `SELECT id, event_id AS eventId, match_no AS matchNo, title, status,
            scheduled_at AS scheduledAt, published_at AS publishedAt, rating_gap AS ratingGap,
            generation_algo_version AS algoVersion, generation_seed AS seed, version,
            radiant_win AS radiantWin, duration_seconds AS durationSeconds,
            dota_match_id AS dotaMatchId, completed_at AS completedAt,
            created_at AS createdAt
       FROM matches WHERE id = ?`,
  )
    .bind(matchId)
    .first<{
      id: string;
      eventId: string;
      matchNo: number;
      title: string | null;
      status: string;
      scheduledAt: number | null;
      publishedAt: number | null;
      ratingGap: number | null;
      algoVersion: string | null;
      seed: number | null;
      version: number;
      radiantWin: number | null;
      durationSeconds: number | null;
      dotaMatchId: string | null;
      completedAt: number | null;
      createdAt: number;
    }>();

  if (!match) throw new ApiError('NOT_FOUND', '比赛不存在');

  const teams = await env.DB.prepare(
    `SELECT id, side, name, total_rating AS totalRating, average_rating AS averageRating,
            position_coverage_bp AS positionCoverageBp
       FROM teams WHERE match_id = ? ORDER BY side DESC`,
  )
    .bind(matchId)
    .all<{
      id: string;
      side: string;
      name: string;
      totalRating: number;
      averageRating: number;
      positionCoverageBp: number;
    }>();

  const members = await env.DB.prepare(
    `SELECT tm.id, tm.team_id AS teamId, tm.user_id AS userId, u.display_name AS displayName,
            tm.assigned_position AS position, tm.position_fit_score AS fitScore,
            tm.effective_rating_snapshot AS effectiveRating, tm.is_substitute AS isSubstitute
       FROM team_members tm JOIN users u ON u.id = tm.user_id
      WHERE tm.match_id = ? ORDER BY tm.assigned_position ASC`,
  )
    .bind(matchId)
    .all<{
      id: string;
      teamId: string;
      userId: string;
      displayName: string;
      position: number;
      fitScore: number;
      effectiveRating: number;
      isSubstitute: number;
    }>();

  const memberRows = members.results ?? [];
  return {
    match: {
      ...match,
      teams: (teams.results ?? []).map((team) => ({
        ...team,
        members: memberRows.filter((member) => member.teamId === team.id),
      })),
    },
  };
}

/* ==========================================================================
 * 生成阵容（管理员）
 * ======================================================================== */
adminMatchRoutes.post('/generate', async (c) => {
  const adminId = requireAdmin(c);
  const env = c.env;
  const parsed = generateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw new ApiError('VALIDATION_FAILED', '输入不合法', parsed.error.flatten().fieldErrors);
  }

  const event = await loadEvent(env, parsed.data.eventId);
  const result = await generateMatchLineup(
    env,
    { id: event.id, status: event.status },
    {
      matchNo: parsed.data.matchNo,
      seed: parsed.data.seed,
      playerIds: parsed.data.playerIds,
      actor: { id: adminId, role: 'ADMIN' },
    },
  );

  return c.json(
    {
      data: {
        matchId: result.matchId,
        version: result.version,
        ratingGap: result.ratingGap,
        cost: result.cost,
        warnings: result.warnings,
        teams: result.teams,
      },
      meta: { requestId: c.get('requestId') },
    },
    201,
  );
});

adminMatchRoutes.get('/:id/lineup', async (c) => {
  requireAdmin(c);
  return c.json({ data: await loadLineup(c.env, c.req.param('id')) });
});

/* ==========================================================================
 * 拖拽换人：整份提交，不做"逐次 PATCH 单个位置"
 *
 * 为什么整份提交：一次拖拽往往同时改动两个人的位置（A→B、B→A）。
 * 逐条提交会在中间态出现"两队各 4 人"或"同一位置站两个人"，
 * 这个中间态会被唯一索引拒绝，也会被其它读请求看到。
 * ========================================================================== */
const lineupMoveSchema = z.object({
  teamMemberId: z.string().min(1),
  toSide: z.enum(['RADIANT', 'DIRE']),
  toPosition: z.number().int().min(1).max(5),
});

const lineupPatchSchema = z.object({
  /** 乐观锁：客户端读到的版本号，不一致说明别人先改过了 */
  version: z.number().int().nonnegative(),
  moves: z.array(lineupMoveSchema).min(1).max(10),
});

interface LineupMemberRow {
  id: string;
  teamId: string;
  userId: string;
  teamSide: 'RADIANT' | 'DIRE';
  position: number;
  fitScore: number;
  systemRating: number;
  adminAdjustment: number;
  effectiveRating: number;
  isSubstitute: number;
  createdAt: number;
}

adminMatchRoutes.patch('/:id/lineup', async (c) => {
  requireAdmin(c);
  const env = c.env;

  const match = await env.DB.prepare(
    `SELECT id, event_id AS eventId, status, version FROM matches WHERE id = ?`,
  )
    .bind(c.req.param('id'))
    .first<{ id: string; eventId: string; status: string; version: number }>();
  if (!match) throw new ApiError('NOT_FOUND', '比赛不存在');
  if (match.status !== 'DRAFT') {
    throw new ApiError('CONFLICT', `阵容已发布（${match.status}），不能再调整；需要改动请重新生成`);
  }

  const parsed = lineupPatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw new ApiError('VALIDATION_FAILED', '输入不合法', parsed.error.flatten().fieldErrors);
  }
  if (parsed.data.version !== match.version) {
    throw new ApiError('CONFLICT', '阵容已被其他人修改，请刷新后重试');
  }

  const teams = await env.DB.prepare(`SELECT id, side FROM teams WHERE match_id = ?`)
    .bind(match.id)
    .all<{ id: string; side: 'RADIANT' | 'DIRE' }>();
  const teamBySide = new Map((teams.results ?? []).map((team) => [team.side, team.id]));
  if (teamBySide.size !== 2) throw new ApiError('CONFLICT', '阵容数据不完整（队伍缺失）');

  const rows = await env.DB.prepare(
    `SELECT id, team_id AS teamId, user_id AS userId, team_side AS teamSide,
            assigned_position AS position, position_fit_score AS fitScore,
            system_rating_snapshot AS systemRating, admin_adjustment_snapshot AS adminAdjustment,
            effective_rating_snapshot AS effectiveRating, is_substitute AS isSubstitute,
            created_at AS createdAt
       FROM team_members WHERE match_id = ?`,
  )
    .bind(match.id)
    .all<LineupMemberRow>();

  const members = rows.results ?? [];
  const byId = new Map(members.map((member) => [member.id, member]));

  // ---- 应用 moves（只改内存，校验通过后再落库） ----
  for (const move of parsed.data.moves) {
    const member = byId.get(move.teamMemberId);
    if (!member) {
      throw new ApiError('VALIDATION_FAILED', '有 move 指向不属于这场比赛的队员');
    }
    member.teamId = teamBySide.get(move.toSide) ?? member.teamId;
    member.teamSide = move.toSide;
    member.position = move.toPosition;
  }

  // ---- 校验不变量：每边 5 人，位置 1..5 各一个 ----
  for (const side of ['RADIANT', 'DIRE'] as const) {
    const lineup = members.filter((m) => m.teamSide === side && m.isSubstitute === 0);
    if (lineup.length !== TEAM_SIZE) {
      throw new ApiError('CONFLICT', `${side} 需要正好 ${TEAM_SIZE} 人，当前 ${lineup.length} 人`);
    }
    const positions = new Set(lineup.map((m) => m.position));
    if (positions.size !== TEAM_SIZE) {
      throw new ApiError('CONFLICT', `${side} 有重复位置（同一个位置站了两个人）`);
    }
  }

  // ---- 位置变了，契合度必须跟着重算，否则覆盖度统计是假的 ----
  // 取值口径必须和生成阵容时一致：当前档案 > 报名快照 > 报名时填的主位置
  // （直接用 player_positions 会让"报名时选了位置但没填档案"的人全部变成 10 分）
  const registrations = await env.DB.prepare(
    `SELECT user_id AS userId, position_snapshot AS positionSnapshot,
            position_preference AS fallbackPosition
       FROM registrations WHERE event_id = ?`,
  )
    .bind(match.eventId)
    .all<{ userId: string; positionSnapshot: string | null; fallbackPosition: number | null }>();

  const regByUser = new Map((registrations.results ?? []).map((row) => [row.userId, row]));
  const withPositions = await attachPositions(
    env,
    members.map((member) => ({
      userId: member.userId,
      displayName: '',
      rating: member.effectiveRating,
      systemRating: member.systemRating,
      adjustment: member.adminAdjustment,
      positionSnapshot: regByUser.get(member.userId)?.positionSnapshot ?? null,
      fallbackPosition: regByUser.get(member.userId)?.fallbackPosition ?? null,
    })),
  );
  const positionsByUser = new Map(withPositions.map((player) => [player.userId, player.positions]));

  for (const member of members) {
    if (member.isSubstitute === 0) {
      member.fitScore = computePositionFit(
        positionsByUser.get(member.userId) ?? [],
        member.position as 1 | 2 | 3 | 4 | 5,
      );
    }
  }

  // ---- 重算两队总分 / 均分 / 位置覆盖 ----
  const aggregates = (['RADIANT', 'DIRE'] as const).map((side) => {
    const lineup = members.filter((m) => m.teamSide === side && m.isSubstitute === 0);
    const total = lineup.reduce((sum, m) => sum + m.effectiveRating, 0);
    const conflictFree = lineup.filter((m) => m.fitScore >= CONFLICT_THRESHOLD).length;
    return {
      side,
      teamId: teamBySide.get(side) as string,
      total,
      average: Math.round(total / TEAM_SIZE),
      coverageBp: Math.round((conflictFree / TEAM_SIZE) * 10000),
    };
  });
  const gap = Math.abs((aggregates[0]?.total ?? 0) - (aggregates[1]?.total ?? 0));

  const now = Date.now();

  /**
   * 落库用"删了重插"而不是逐条 UPDATE：
   * (team_id, assigned_position) 上有唯一索引，A→2 / B→1 这种互换无论先改谁都会
   * 撞上中间态。batch 是事务，删+插之间不会被读到。
   */
  const statements = [
    env.DB.prepare(`DELETE FROM team_members WHERE match_id = ?`).bind(match.id),
    ...members.map((member) =>
      env.DB.prepare(
        `INSERT INTO team_members (id, team_id, match_id, user_id, team_side, assigned_position,
           position_fit_score, system_rating_snapshot, admin_adjustment_snapshot,
           effective_rating_snapshot, is_substitute, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        member.id,
        member.teamId,
        match.id,
        member.userId,
        member.teamSide,
        member.position,
        member.fitScore,
        member.systemRating,
        member.adminAdjustment,
        member.effectiveRating,
        member.isSubstitute,
        member.createdAt,
      ),
    ),
    ...aggregates.map((team) =>
      env.DB.prepare(
        `UPDATE teams SET total_rating = ?, average_rating = ?, position_coverage_bp = ?, updated_at = ?
          WHERE id = ?`,
      ).bind(team.total, team.average, team.coverageBp, now, team.teamId),
    ),
    env.DB.prepare(
      `UPDATE matches SET version = version + 1, rating_gap = ?, updated_at = ? WHERE id = ?`,
    ).bind(gap, now, match.id),
  ];

  await env.DB.batch(statements);

  return c.json({ data: await loadLineup(env, match.id) });
});

/* ==========================================================================
 * 发布：先校验人数、队伍数，再冻结快照
 * ======================================================================== */
adminMatchRoutes.post('/:id/publish', async (c) => {
  const adminId = requireAdmin(c);
  const matchId = c.req.param('id');

  await publishMatch(c.env, matchId, { id: adminId, role: 'ADMIN' }, c.get('requestId'));

  return c.json({ data: await loadLineup(c.env, matchId) });
});

/* ==========================================================================
 * 录入比赛结果
 *
 * 手工录入是 V1 的正式路径：不是所有人都开着「公开比赛数据」，
 * 而且社区内战本身也未必会被 OpenDota 收录。
 * ======================================================================== */
const resultSchema = z.object({
  radiantWin: z.boolean(),
  durationSeconds: z.number().int().min(300).max(14_400).optional(),
  dotaMatchId: z
    .string()
    .regex(/^\d{6,20}$/, 'DOTA2 比赛 ID 应为 6~20 位数字')
    .optional(),
});

adminMatchRoutes.post('/:id/result', async (c) => {
  const adminId = requireAdmin(c);
  const env = c.env;

  const parsed = resultSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw new ApiError('VALIDATION_FAILED', '输入不合法', parsed.error.flatten().fieldErrors);
  }

  const match = await env.DB.prepare(
    `SELECT id, event_id AS eventId, status, match_no AS matchNo FROM matches WHERE id = ?`,
  )
    .bind(c.req.param('id'))
    .first<{ id: string; eventId: string; status: string; matchNo: number }>();
  if (!match) throw new ApiError('NOT_FOUND', '比赛不存在');

  if (match.status !== 'PUBLISHED' && match.status !== 'IN_PROGRESS') {
    throw new ApiError('CONFLICT', `当前状态（${match.status}）不能录入结果`);
  }

  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE matches SET status = 'COMPLETED', radiant_win = ?, duration_seconds = ?,
         dota_match_id = COALESCE(?, dota_match_id), completed_at = ?, updated_at = ?
       WHERE id = ?`,
    ).bind(
      parsed.data.radiantWin ? 1 : 0,
      parsed.data.durationSeconds ?? null,
      parsed.data.dotaMatchId ?? null,
      now,
      now,
      match.id,
    ),
    // 该赛事所有场次都结束时，赛事自动进入 COMPLETED；还有未打的场次就保持 PUBLISHED
    env.DB.prepare(
      `UPDATE events SET status = 'COMPLETED', updated_at = ?
        WHERE id = ? AND status = 'PUBLISHED'
          AND NOT EXISTS (
            SELECT 1 FROM matches
             WHERE event_id = ? AND status IN ('DRAFT', 'PUBLISHED', 'IN_PROGRESS')
          )`,
    ).bind(now, match.eventId, match.eventId),
    env.DB.prepare(
      `INSERT INTO audit_logs (id, actor_id, actor_role, action, entity_type, entity_id,
         after_json, request_id, created_at)
       VALUES (?, ?, 'ADMIN', 'match.result', 'match', ?, ?, ?, ?)`,
    ).bind(
      newId(now),
      adminId,
      match.id,
      JSON.stringify({
        matchNo: match.matchNo,
        radiantWin: parsed.data.radiantWin,
        durationSeconds: parsed.data.durationSeconds ?? null,
      }),
      c.get('requestId') ?? null,
      now,
    ),
  ]);

  // 录入结果会改变出勤口径（这场变成 COMPLETED，赛事可能整体完成）：
  // 立刻重算该赛事所有相关玩家的评分，否则出勤那 100 分要等管理员手动重算才动
  const recomputed = await recomputeEventRatings(env, match.eventId);

  return c.json({ data: { ...(await loadLineup(env, match.id)), recomputedRatings: recomputed } });
});

/* ==========================================================================
 * 流局：不删数据，只置 VOID，战绩与审计保留
 * ======================================================================== */
adminMatchRoutes.post('/:id/void', async (c) => {
  const adminId = requireAdmin(c);
  const env = c.env;

  const body = (await c.req.json().catch(() => ({}))) as { reason?: string };

  const match = await env.DB.prepare(
    `SELECT id, status, match_no AS matchNo FROM matches WHERE id = ?`,
  )
    .bind(c.req.param('id'))
    .first<{ id: string; status: string; matchNo: number }>();
  if (!match) throw new ApiError('NOT_FOUND', '比赛不存在');
  if (!['DRAFT', 'PUBLISHED', 'IN_PROGRESS'].includes(match.status)) {
    throw new ApiError('CONFLICT', `当前状态（${match.status}）不能流局`);
  }

  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`UPDATE matches SET status = 'VOID', updated_at = ? WHERE id = ?`).bind(now, match.id),
    env.DB.prepare(
      `INSERT INTO audit_logs (id, actor_id, actor_role, action, entity_type, entity_id,
         before_json, reason, request_id, created_at)
       VALUES (?, ?, 'ADMIN', 'match.void', 'match', ?, ?, ?, ?)`,
    ).bind(
      newId(now),
      adminId,
      match.id,
      JSON.stringify({ status: match.status, matchNo: match.matchNo }),
      body.reason?.slice(0, 200) ?? null,
      c.get('requestId') ?? null,
      now,
    ),
  ]);

  return c.json({ data: await loadLineup(env, match.id) });
});

/* ==========================================================================
 * 公开阵容：只有发布后才对外可见
 * ======================================================================== */
publicMatchRoutes.get('/:id', async (c) => {
  const match = await c.env.DB.prepare(`SELECT status FROM matches WHERE id = ?`)
    .bind(c.req.param('id'))
    .first<{ status: string }>();
  if (!match) throw new ApiError('NOT_FOUND', '比赛不存在');

  const visible = ['PUBLISHED', 'IN_PROGRESS', 'COMPLETED'];
  if (!visible.includes(match.status) && c.get('role') !== 'ADMIN') {
    throw new ApiError('NOT_FOUND', '比赛不存在');
  }

  return c.json({ data: await loadLineup(c.env, c.req.param('id')) });
});
