import { Hono } from 'hono';
import { z } from 'zod';
import { ApiError, newId } from '@hive/shared';
import type { AppEnv, Env } from '../env';
import { requireAdmin } from '../guard';
import { computePositionFit, CONFLICT_THRESHOLD, type BalanceResult } from '../algorithms/team-balancing';
import { MATCH_SIZE, TEAM_SIZE } from '../services/roster';
import { attachPositions, generateMatchLineup, publishMatch } from '../services/lineup';
import { buildBench } from '../services/bench';
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
    `SELECT tm.id, tm.team_id AS teamId, tm.user_id AS userId,
            COALESCE(u.display_name, tm.guest_name) AS displayName,
            tm.is_guest AS isGuest, tm.guest_mmr AS guestMmr,
            tm.assigned_position AS position, tm.position_fit_score AS fitScore,
            tm.effective_rating_snapshot AS effectiveRating, tm.is_substitute AS isSubstitute
       FROM team_members tm LEFT JOIN users u ON u.id = tm.user_id
      WHERE tm.match_id = ? ORDER BY tm.assigned_position ASC`,
  )
    .bind(matchId)
    .all<{
      id: string;
      teamId: string;
      userId: string | null;
      displayName: string | null;
      isGuest: number;
      guestMmr: number | null;
      position: number;
      fitScore: number;
      effectiveRating: number;
      isSubstitute: number;
    }>();

  const memberRows = members.results ?? [];

  /**
   * 替补顶上来的是谁：阵容里只显示「临时」看不出换掉了谁，
   * 这里按 in_member_id 把被换下的人名带上（`replacedName`），
   * 供阵容页渲染「临时 · 替 朝田诗乃」。换人流水本身是 append-only，不改阵容数据。
   *
   * out_user_id / in_name / position 同时被下面的"未进阵容"名单复用：
   * 一个人被换下之后，team_members 里那一行已经删了，只剩这条流水能证明他来过。
   */
  const substitutions = await env.DB.prepare(
    `SELECT in_member_id AS inMemberId, out_name AS outName, reason,
            out_user_id AS outUserId, in_name AS inName,
            assigned_position AS position, created_at AS createdAt
       FROM match_substitutions WHERE match_id = ? ORDER BY created_at ASC`,
  )
    .bind(matchId)
    .all<{
      inMemberId: string;
      outName: string | null;
      reason: string;
      outUserId: string | null;
      inName: string | null;
      position: number | null;
      createdAt: number;
    }>();

  const replacedByMember = new Map(
    (substitutions.results ?? []).map((row) => [
      row.inMemberId,
      { outName: row.outName ?? '', reason: row.reason },
    ]),
  );

  /**
   * 没进这套阵容的人：本场被换下的（含弃赛）、赛事里的候补、正选但没排到的、截止前退赛的。
   * 三种状态都要查，因为"没进阵容"不等于"不是正选"——12 人报名只开一场时，
   * 剩下 2 个人状态仍是 CONFIRMED，但一场只上 10 人（见 services/bench.ts）。
   *
   * 位置要显式挑整数列：`position_snapshot` 在部分行里存的是**偏好数组 JSON**
   * （如 `[{"position":1,"rank":1},…]`），直接 COALESCE 会把这串 JSON 拼进"号位"里。
   */
  const benchRegistrations = await env.DB.prepare(
    `SELECT r.user_id AS userId, u.display_name AS displayName, r.status,
            CASE
              WHEN r.position_preference BETWEEN 1 AND 5 THEN r.position_preference
              WHEN r.position_snapshot BETWEEN 1 AND 5 THEN r.position_snapshot
              ELSE NULL
            END AS position,
            r.waitlist_position AS waitlistPosition,
            r.effective_rating_snapshot AS rating
       FROM registrations r JOIN users u ON u.id = r.user_id
      WHERE r.event_id = ? AND r.status IN ('WAITLIST', 'CONFIRMED', 'WITHDRAWN')`,
  )
    .bind(match.eventId)
    .all<{
      userId: string;
      displayName: string | null;
      status: string;
      position: number | null;
      waitlistPosition: number | null;
      rating: number | null;
    }>();

  /**
   * 该赛事**所有场次**阵容里出现过的人。用来把"在另一场上场的人"排除掉：
   * 一个赛事开两场时，另一场的 10 个人也不在这套阵容里，但他们不是没进阵容。
   */
  const eventLineup = await env.DB.prepare(
    `SELECT DISTINCT tm.user_id AS userId
       FROM team_members tm JOIN matches m ON m.id = tm.match_id
      WHERE m.event_id = ? AND tm.user_id IS NOT NULL`,
  )
    .bind(match.eventId)
    .all<{ userId: string }>();

  const bench = buildBench({
    substitutions: substitutions.results ?? [],
    registrations: benchRegistrations.results ?? [],
    lineupUserIds: new Set(
      memberRows.map((member) => member.userId).filter((id): id is string => Boolean(id)),
    ),
    eventLineupUserIds: new Set((eventLineup.results ?? []).map((row) => row.userId)),
  });

  return {
    match: {
      ...match,
      bench,
      teams: (teams.results ?? []).map((team) => ({
        ...team,
        members: memberRows
          .filter((member) => member.teamId === team.id)
          .map((member) => ({
            ...member,
            /** 被这个替补换下去的人（只有换上来的人才有；原生阵容为 null） */
            replacedName: replacedByMember.get(member.id)?.outName ?? null,
            replaceReason: replacedByMember.get(member.id)?.reason ?? null,
          })),
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
  /** 临时参赛者没有账号，user_id 为空 */
  userId: string | null;
  guestName: string | null;
  guestMmr: number | null;
  isGuest: number;
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
    `SELECT id, team_id AS teamId, user_id AS userId, guest_name AS guestName,
            guest_mmr AS guestMmr, is_guest AS isGuest, team_side AS teamSide,
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
  // 临时参赛者没有档案，位置契合度沿用换人时记下的值
  const registeredMembers = members.filter(
    (member): member is LineupMemberRow & { userId: string } => Boolean(member.userId),
  );
  const withPositions = await attachPositions(
    env,
    registeredMembers.map((member) => ({
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

  for (const member of registeredMembers) {
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
        `INSERT INTO team_members (id, team_id, match_id, user_id, guest_name, guest_mmr,
           team_side, assigned_position, position_fit_score, system_rating_snapshot,
           admin_adjustment_snapshot, effective_rating_snapshot, is_substitute, is_guest, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        member.id,
        member.teamId,
        match.id,
        member.userId,
        member.guestName,
        member.guestMmr,
        member.teamSide,
        member.position,
        member.fitScore,
        member.systemRating,
        member.adminAdjustment,
        member.effectiveRating,
        member.isSubstitute,
        member.isGuest,
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
 * 换人 / 临时参赛
 *
 * 场景：阵容发布后，正选里有人来不了。管理员把他换下去，从本赛事候补里挑一个补位；
 * 也可能来了个完全没报名的朋友，临时上场（只填名字，可选天梯分）。
 *
 * 与拖拽换位的区别：这里是"换人"而不是"换位置"——总分、分差、换人流水都要跟着动，
 * 而且允许发生在 PUBLISHED 之后（比赛开始前才有人说不来，这才是真实场景）。
 * ========================================================================== */
const substitutionSchema = z
  .object({
    outMemberId: z.string().min(1),
    /** 替补：本赛事已报名的玩家 */
    inUserId: z.string().min(1).optional(),
    /** 临时参赛：没报名的人，只记名字（可选天梯分） */
    guest: z
      .object({
        name: z.string().trim().min(1).max(32),
        mmr: z.number().int().min(0).max(20_000).nullable().optional(),
      })
      .optional(),
    reason: z.enum(['ABSENT', 'MANUAL']).default('ABSENT'),
    note: z.string().trim().max(200).optional(),
  })
  .refine((data) => Boolean(data.inUserId) !== Boolean(data.guest), {
    message: '替补玩家与临时参赛只能二选一',
    path: ['inUserId'],
  });

/** 换人候选：本赛事报名、但还没进这场阵容的人；顺带返回本场的换人流水 */
adminMatchRoutes.get('/:id/substitutes', async (c) => {
  requireAdmin(c);
  const env = c.env;

  const match = await env.DB.prepare(
    `SELECT id, event_id AS eventId, status FROM matches WHERE id = ?`,
  )
    .bind(c.req.param('id'))
    .first<{ id: string; eventId: string; status: string }>();
  if (!match) throw new ApiError('NOT_FOUND', '比赛不存在');

  const inMatch = await env.DB.prepare(
    `SELECT user_id AS userId FROM team_members WHERE match_id = ? AND user_id IS NOT NULL`,
  )
    .bind(match.id)
    .all<{ userId: string }>();
  const taken = new Set((inMatch.results ?? []).map((row) => row.userId));

  const elsewhere = await env.DB.prepare(
    `SELECT tm.user_id AS userId, m.match_no AS matchNo
       FROM team_members tm JOIN matches m ON m.id = tm.match_id
      WHERE m.event_id = ? AND m.id <> ? AND tm.user_id IS NOT NULL`,
  )
    .bind(match.eventId, match.id)
    .all<{ userId: string; matchNo: number }>();
  const busy = new Map((elsewhere.results ?? []).map((row) => [row.userId, row.matchNo]));

  const rows = await env.DB.prepare(
    `SELECT r.user_id AS userId, u.display_name AS displayName,
            COALESCE(pr.effective_rating, r.effective_rating_snapshot) AS effectiveRating,
            pr.attendance_bp AS attendanceBp,
            r.created_at AS registeredAt
       FROM registrations r
       JOIN users u ON u.id = r.user_id
       LEFT JOIN player_ratings pr ON pr.user_id = r.user_id
      WHERE r.event_id = ? AND r.status = 'CONFIRMED'`,
  )
    .bind(match.eventId)
    .all<{
      userId: string;
      displayName: string;
      effectiveRating: number;
      attendanceBp: number | null;
      registeredAt: number;
    }>();

  // 排序口径与候补一致：出勤率 → 实力分 → 报名时间
  const bench = (rows.results ?? [])
    .filter((row) => !taken.has(row.userId))
    .map((row) => ({ ...row, busyInMatchNo: busy.get(row.userId) ?? null }))
    .sort(
      (a, b) =>
        (b.attendanceBp ?? 5000) - (a.attendanceBp ?? 5000) ||
        b.effectiveRating - a.effectiveRating ||
        a.registeredAt - b.registeredAt,
    );

  const history = await env.DB.prepare(
    `SELECT id, out_name AS outName, in_name AS inName, in_is_guest AS inIsGuest,
            team_side AS teamSide, assigned_position AS position, reason, note,
            created_at AS createdAt
       FROM match_substitutions WHERE match_id = ? ORDER BY created_at DESC`,
  )
    .bind(match.id)
    .all();

  return c.json({
    data: { matchId: match.id, eventId: match.eventId, status: match.status, bench, history: history.results ?? [] },
  });
});

adminMatchRoutes.post('/:id/substitutions', async (c) => {
  const adminId = requireAdmin(c);
  const env = c.env;

  const match = await env.DB.prepare(
    `SELECT id, event_id AS eventId, status FROM matches WHERE id = ?`,
  )
    .bind(c.req.param('id'))
    .first<{ id: string; eventId: string; status: string }>();
  if (!match) throw new ApiError('NOT_FOUND', '比赛不存在');
  if (match.status !== 'DRAFT' && match.status !== 'PUBLISHED') {
    throw new ApiError('CONFLICT', '比赛已结束或已流局，不能再换人');
  }

  const parsed = substitutionSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw new ApiError('VALIDATION_FAILED', '输入不合法', parsed.error.flatten().fieldErrors);
  }
  const input = parsed.data;

  const out = await env.DB.prepare(
    `SELECT tm.id, tm.team_id AS teamId, tm.user_id AS userId, tm.guest_name AS guestName,
            tm.team_side AS teamSide, tm.assigned_position AS position,
            tm.effective_rating_snapshot AS effectiveRating,
            COALESCE(u.display_name, tm.guest_name) AS displayName
       FROM team_members tm LEFT JOIN users u ON u.id = tm.user_id
      WHERE tm.id = ? AND tm.match_id = ?`,
  )
    .bind(input.outMemberId, match.id)
    .first<{
      id: string;
      teamId: string;
      userId: string | null;
      guestName: string | null;
      teamSide: 'RADIANT' | 'DIRE';
      position: number;
      effectiveRating: number;
      displayName: string | null;
    }>();
  if (!out) throw new ApiError('NOT_FOUND', '要换下的人不在这场比赛的阵容里');

  // 已经在场的人不能重复选
  const existing = await env.DB.prepare(
    `SELECT user_id AS userId FROM team_members WHERE match_id = ? AND user_id IS NOT NULL`,
  )
    .bind(match.id)
    .all<{ userId: string }>();
  const taken = new Set((existing.results ?? []).map((row) => row.userId));

  let inUserId: string | null = null;
  let inName = '';
  let inIsGuest = 0;
  let guestMmr: number | null = null;
  let systemRating = 500;
  let adminAdjustment = 0;
  let effectiveRating = 500;
  let fitScore = 100;

  if (input.inUserId) {
    if (taken.has(input.inUserId)) {
      throw new ApiError('CONFLICT', '这名玩家已经在这场比赛的阵容里了');
    }
    const reg = await env.DB.prepare(
      `SELECT r.status, u.display_name AS displayName,
              COALESCE(pr.system_rating, r.system_rating_snapshot) AS systemRating,
              COALESCE(pr.admin_adjustment, r.admin_adjustment_snapshot) AS adminAdjustment,
              COALESCE(pr.effective_rating, r.effective_rating_snapshot) AS effectiveRating,
              r.position_snapshot AS positionSnapshot,
              r.position_preference AS fallbackPosition
         FROM registrations r JOIN users u ON u.id = r.user_id
         LEFT JOIN player_ratings pr ON pr.user_id = r.user_id
        WHERE r.event_id = ? AND r.user_id = ?`,
    )
      .bind(match.eventId, input.inUserId)
      .first<{
        status: string;
        displayName: string;
        systemRating: number;
        adminAdjustment: number;
        effectiveRating: number;
        positionSnapshot: string | null;
        fallbackPosition: number | null;
      }>();
    if (!reg || reg.status !== 'CONFIRMED') {
      throw new ApiError('CONFLICT', '这名玩家不是本赛事的正选报名者');
    }
    inUserId = input.inUserId;
    inName = reg.displayName;
    systemRating = reg.systemRating;
    adminAdjustment = reg.adminAdjustment;
    effectiveRating = reg.effectiveRating;

    // 位置契合度：和生成阵容时同一套口径（当前档案 > 报名快照 > 报名主位置）
    const [withPositions] = await attachPositions(env, [
      {
        userId: input.inUserId,
        displayName: inName,
        rating: effectiveRating,
        systemRating,
        adjustment: adminAdjustment,
        positionSnapshot: reg.positionSnapshot,
        fallbackPosition: reg.fallbackPosition,
      },
    ]);
    fitScore = computePositionFit(
      withPositions?.positions ?? [],
      out.position as 1 | 2 | 3 | 4 | 5,
    );
  } else {
    const guest = input.guest!;
    inName = guest.name;
    inIsGuest = 1;
    guestMmr = guest.mmr ?? null;
    // 没填天梯分时给中性值，和"没填资料的新人"一致
    systemRating = guestMmr == null ? 500 : Math.max(0, Math.min(1000, Math.round(guestMmr / 10)));
    effectiveRating = systemRating;
  }

  const totals = await env.DB.prepare(
    `SELECT id, side, total_rating AS totalRating FROM teams WHERE match_id = ?`,
  )
    .bind(match.id)
    .all<{ id: string; side: 'RADIANT' | 'DIRE'; totalRating: number }>();

  const teams = totals.results ?? [];
  const target = teams.find((team) => team.id === out.teamId);
  if (!target) throw new ApiError('CONFLICT', '阵容数据不完整（队伍缺失）');

  const now = Date.now();
  const memberId = newId(now);
  const totalRating = target.totalRating - out.effectiveRating + effectiveRating;
  const averageRating = Math.round(totalRating / TEAM_SIZE);
  const opposing = teams.find((team) => team.id !== target.id);
  const gap = Math.abs(totalRating - (opposing?.totalRating ?? 0));

  await env.DB.batch([
    env.DB.prepare(`DELETE FROM team_members WHERE id = ?`).bind(out.id),
    env.DB.prepare(
      `INSERT INTO team_members (id, team_id, match_id, user_id, guest_name, guest_mmr,
         team_side, assigned_position, position_fit_score, system_rating_snapshot,
         admin_adjustment_snapshot, effective_rating_snapshot, is_substitute, is_guest, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    ).bind(
      memberId,
      out.teamId,
      match.id,
      inUserId,
      inIsGuest ? inName : null,
      guestMmr,
      out.teamSide,
      out.position,
      fitScore,
      systemRating,
      adminAdjustment,
      effectiveRating,
      inIsGuest,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO match_substitutions (id, match_id, team_id, out_member_id, out_user_id,
         out_name, in_member_id, in_user_id, in_name, in_is_guest, team_side,
         assigned_position, reason, note, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      newId(now),
      match.id,
      out.teamId,
      out.id,
      out.userId,
      out.displayName ?? '未知',
      memberId,
      inUserId,
      inName,
      inIsGuest,
      out.teamSide,
      out.position,
      input.reason,
      input.note ?? null,
      adminId,
      now,
    ),
    env.DB.prepare(
      `UPDATE teams SET total_rating = ?, average_rating = ?, updated_at = ? WHERE id = ?`,
    ).bind(totalRating, averageRating, now, out.teamId),
    env.DB.prepare(
      `UPDATE matches SET rating_gap = ?, version = version + 1, updated_at = ? WHERE id = ?`,
    ).bind(gap, now, match.id),
    env.DB.prepare(
      `INSERT INTO audit_logs (id, actor_id, actor_role, action, entity_type, entity_id,
         after_json, request_id, created_at)
       VALUES (?, ?, 'ADMIN', 'match.substitute', 'match', ?, ?, ?, ?)`,
    ).bind(
      newId(now),
      adminId,
      match.id,
      JSON.stringify({
        out: out.displayName,
        in: inName,
        isGuest: Boolean(inIsGuest),
        side: out.teamSide,
        position: out.position,
        reason: input.reason,
      }),
      c.get('requestId') ?? null,
      now,
    ),
  ]);

  return c.json({ data: await loadLineup(env, match.id) });
});

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
