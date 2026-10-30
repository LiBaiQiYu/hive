import { Hono } from 'hono';
import { z } from 'zod';
import { ApiError, newId } from '@hive/shared';
import type { AppEnv, Env } from '../env';
import { requireAdmin } from '../guard';
import { balanceTeams, type BalancePlayer, type BalanceResult } from '../algorithms/team-balancing';
import { MATCH_SIZE } from '../services/roster';
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

interface RosterRow {
  userId: string;
  displayName: string;
  rating: number;
  systemRating: number;
  adjustment: number;
  positionSnapshot: string | null;
  /** 报名时提交的主位置，作为快照为空时的兜底 */
  fallbackPosition: number | null;
}

interface PositionEntry {
  position: number;
  rank: number;
  proficiency: number;
}

function parsePositions(raw: string | null): PositionEntry[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (typeof entry !== 'object' || entry === null) return [];
      const candidate = entry as Partial<PositionEntry>;
      if (
        typeof candidate.position !== 'number' ||
        typeof candidate.rank !== 'number' ||
        typeof candidate.proficiency !== 'number'
      ) {
        return [];
      }
      return [
        { position: candidate.position, rank: candidate.rank, proficiency: candidate.proficiency },
      ];
    });
  } catch {
    return [];
  }
}

/**
 * 取第 matchNo 场的 10 人。
 *
 * 顺序与封盘一致：有效评分降序 → 报名时间升序 → id 升序。
 * 评分取**当前** player_ratings 而不是报名快照——否则管理员事后修正的评分永远不生效。
 */
async function pickRoster(
  env: Env,
  eventId: string,
  matchNo: number,
  playerIds?: string[],
): Promise<RosterRow[]> {
  const rows = await env.DB.prepare(
    `SELECT r.user_id AS userId, u.display_name AS displayName,
            COALESCE(pr.effective_rating, r.effective_rating_snapshot) AS rating,
            COALESCE(pr.system_rating, r.system_rating_snapshot) AS systemRating,
            COALESCE(pr.admin_adjustment, r.admin_adjustment_snapshot) AS adjustment,
            r.position_snapshot AS positionSnapshot,
            r.position_preference AS fallbackPosition
       FROM registrations r
       JOIN users u ON u.id = r.user_id
       LEFT JOIN player_ratings pr ON pr.user_id = r.user_id
      WHERE r.event_id = ? AND r.status = 'CONFIRMED'
      ORDER BY COALESCE(pr.effective_rating, r.effective_rating_snapshot) DESC, r.created_at ASC, r.id ASC`,
  )
    .bind(eventId)
    .all<RosterRow>();

  const all = rows.results ?? [];

  if (playerIds) {
    const byId = new Map(all.map((row) => [row.userId, row]));
    return playerIds.map((id) => {
      const row = byId.get(id);
      if (!row) throw new ApiError('CONFLICT', `玩家 ${id} 不在该赛事的正选名单中`);
      return row;
    });
  }

  const slice = all.slice((matchNo - 1) * MATCH_SIZE, matchNo * MATCH_SIZE);
  if (slice.length < MATCH_SIZE) {
    throw new ApiError('CONFLICT', `正选人数不足，第 ${matchNo} 场还缺 ${MATCH_SIZE - slice.length} 人`);
  }
  return slice;
}

/**
 * 位置偏好的取值优先级：**当前档案 > 报名快照 > 报名时填的主位置**。
 *
 * 为什么当前档案优先：位置偏好变化很慢，但玩家往往是在报名之后才补全档案。
 * 若死守报名那一刻的空快照，新填的位置永远不生效，分组会一直报"全员位置冲突"。
 * 快照仍保留，用于事后复盘"当时按什么分组的"。
 */
async function attachPositions(env: Env, rows: RosterRow[]): Promise<BalancePlayer[]> {
  if (rows.length === 0) return [];

  const placeholders = rows.map(() => '?').join(',');
  const current = await env.DB.prepare(
    `SELECT user_id AS userId, position, preference_rank AS rank, proficiency
       FROM player_positions WHERE user_id IN (${placeholders})
      ORDER BY user_id, preference_rank ASC`,
  )
    .bind(...rows.map((row) => row.userId))
    .all<PositionEntry & { userId: string }>();

  const byUser = new Map<string, PositionEntry[]>();
  for (const entry of current.results ?? []) {
    const list = byUser.get(entry.userId) ?? [];
    list.push({ position: entry.position, rank: entry.rank, proficiency: entry.proficiency });
    byUser.set(entry.userId, list);
  }

  return rows.map((row) => {
    let positions = byUser.get(row.userId) ?? [];
    if (positions.length === 0) positions = parsePositions(row.positionSnapshot);
    if (positions.length === 0 && row.fallbackPosition !== null) {
      positions = [{ position: row.fallbackPosition, rank: 1, proficiency: 50 }];
    }
    return { userId: row.userId, rating: row.rating, positions };
  });
}

/** 落库：一个 batch 写完 teams + team_members，避免"两队各 3 人"的中间态被读到 */
async function persistLineup(
  env: Env,
  matchId: string,
  eventId: string,
  result: BalanceResult,
  rows: RosterRow[],
): Promise<void> {
  const now = Date.now();
  const byUser = new Map(rows.map((row) => [row.userId, row]));
  const statements = [];

  for (const team of result.teams) {
    const teamId = newId(now);
    statements.push(
      env.DB.prepare(
        `INSERT INTO teams (id, match_id, event_id, side, name, total_rating, average_rating,
           position_coverage_bp, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        teamId,
        matchId,
        eventId,
        team.side,
        team.side === 'RADIANT' ? 'Radiant' : 'Dire',
        team.totalRating,
        team.averageRating,
        team.positionCoverageBp,
        now,
        now,
      ),
    );

    for (const member of team.members) {
      const snapshot = byUser.get(member.userId);
      statements.push(
        env.DB.prepare(
          `INSERT INTO team_members (id, team_id, match_id, user_id, team_side, assigned_position,
             position_fit_score, system_rating_snapshot, admin_adjustment_snapshot,
             effective_rating_snapshot, is_substitute, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
        ).bind(
          newId(now),
          teamId,
          matchId,
          member.userId,
          team.side,
          member.position,
          member.fitScore,
          snapshot?.systemRating ?? 500,
          snapshot?.adjustment ?? 0,
          member.rating,
          now,
        ),
      );
    }
  }

  await env.DB.batch(statements);
}

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
    `SELECT tm.team_id AS teamId, tm.user_id AS userId, u.display_name AS displayName,
            tm.assigned_position AS position, tm.position_fit_score AS fitScore,
            tm.effective_rating_snapshot AS effectiveRating, tm.is_substitute AS isSubstitute
       FROM team_members tm JOIN users u ON u.id = tm.user_id
      WHERE tm.match_id = ? ORDER BY tm.assigned_position ASC`,
  )
    .bind(matchId)
    .all<{
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
  if (event.status !== 'REGISTRATION_CLOSED' && event.status !== 'PUBLISHED') {
    throw new ApiError('CONFLICT', '请先关闭报名再生成阵容');
  }

  const matchNo = parsed.data.matchNo ?? 1;
  const rows = await pickRoster(env, event.id, matchNo, parsed.data.playerIds);
  const seed = parsed.data.seed ?? 0;

  // 纯函数，1~2ms，同步跑在请求里；不需要 outbox
  const result = balanceTeams(await attachPositions(env, rows), { seed });

  const now = Date.now();
  const existing = await env.DB.prepare(
    `SELECT id, status, version FROM matches WHERE event_id = ? AND match_no = ?`,
  )
    .bind(event.id, matchNo)
    .first<{ id: string; status: string; version: number }>();

  if (existing && existing.status !== 'DRAFT') {
    throw new ApiError('CONFLICT', '该场次已发布，不能重新生成。如需调整请先流局');
  }

  const matchId = existing?.id ?? newId(now);
  const version = (existing?.version ?? 0) + 1;

  if (existing) {
    // 级联删除 teams -> team_members，再整体重写
    await env.DB.prepare(`DELETE FROM teams WHERE match_id = ?`).bind(matchId).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO matches (id, event_id, match_no, title, status, generation_algo_version,
         generation_seed, rating_gap, version, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        matchId,
        event.id,
        matchNo,
        `第 ${matchNo} 场`,
        result.algoVersion,
        result.seed,
        result.ratingGap,
        version,
        adminId,
        now,
        now,
      )
      .run();
  }

  await persistLineup(env, matchId, event.id, result, rows);

  await env.DB.prepare(
    `UPDATE matches SET generation_algo_version = ?, generation_seed = ?, rating_gap = ?,
       version = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(result.algoVersion, result.seed, result.ratingGap, version, now, matchId)
    .run();

  return c.json(
    {
      data: {
        matchId,
        version,
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
 * 发布：先校验人数、队伍数，再冻结快照
 * ======================================================================== */
adminMatchRoutes.post('/:id/publish', async (c) => {
  const adminId = requireAdmin(c);
  const env = c.env;

  const match = await env.DB.prepare(
    `SELECT id, event_id AS eventId, status, match_no AS matchNo FROM matches WHERE id = ?`,
  )
    .bind(c.req.param('id'))
    .first<{ id: string; eventId: string; status: string; matchNo: number }>();
  if (!match) throw new ApiError('NOT_FOUND', '比赛不存在');
  if (match.status !== 'DRAFT') throw new ApiError('CONFLICT', '只有草稿状态的阵容可以发布');

  const teamCount = await env.DB.prepare(`SELECT count(*) AS c FROM teams WHERE match_id = ?`)
    .bind(match.id)
    .first<{ c: number }>();
  const memberCount = await env.DB.prepare(
    `SELECT count(*) AS c FROM team_members WHERE match_id = ? AND is_substitute = 0`,
  )
    .bind(match.id)
    .first<{ c: number }>();

  if ((teamCount?.c ?? 0) !== 2 || (memberCount?.c ?? 0) !== MATCH_SIZE) {
    throw new ApiError(
      'CONFLICT',
      `阵容不完整：${teamCount?.c ?? 0} 支队伍 / ${memberCount?.c ?? 0} 名正选，应为 2 支 / ${MATCH_SIZE} 名`,
    );
  }

  const gap = await env.DB.prepare(`SELECT rating_gap AS gap FROM matches WHERE id = ?`)
    .bind(match.id)
    .first<{ gap: number | null }>();

  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE matches SET status = 'PUBLISHED', published_at = ?, updated_at = ? WHERE id = ?`,
    ).bind(now, now, match.id),
    // 赛事只要有一场阵容发布，就进入 PUBLISHED；全部结束时由管理员流转到 COMPLETED
    env.DB.prepare(
      `UPDATE events SET status = 'PUBLISHED', updated_at = ?
        WHERE id = ? AND status IN ('REGISTRATION_CLOSED')`,
    ).bind(now, match.eventId),
    env.DB.prepare(
      `INSERT INTO audit_logs (id, actor_id, actor_role, action, entity_type, entity_id,
         after_json, request_id, created_at)
       VALUES (?, ?, 'ADMIN', 'match.publish', 'match', ?, ?, ?, ?)`,
    ).bind(
      newId(now),
      adminId,
      match.id,
      JSON.stringify({ matchNo: match.matchNo, ratingGap: gap?.gap ?? null }),
      c.get('requestId') ?? null,
      now,
    ),
  ]);

  return c.json({ data: await loadLineup(env, match.id) });
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

  return c.json({ data: await loadLineup(env, match.id) });
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
