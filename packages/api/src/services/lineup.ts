/**
 * 阵容生成与发布。
 *
 * 为什么单独成文件：这套逻辑有两个入口——
 *   · 管理员在后台点「生成阵容」/「发布」
 *   · 报名到点后由 Cron 自动跑（见 `services/event-auto.ts`）
 * 两边必须给出完全一致的结果，否则会出现"自动分好的队和手动分的队不一样"。
 *
 * 纯逻辑（分队算法）在 `algorithms/team-balancing.ts`，这里只负责取人、
 * 落库、发布与审计。
 */
import { ApiError, newId } from '@hive/shared';
import type { Env } from '../env';
import {
  balanceTeams,
  type BalancePlayer,
  type BalanceResult,
  type BalanceWarning,
} from '../algorithms/team-balancing';
import { MATCH_SIZE } from './roster';

export interface RosterRow {
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

/** 谁发起的：管理员手动，或 Cron 自动（审计里 actor_role 分别是 ADMIN / SYSTEM） */
export interface LineupActor {
  id: string | null;
  role: 'ADMIN' | 'SYSTEM';
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
export async function attachPositions(env: Env, rows: RosterRow[]): Promise<BalancePlayer[]> {  if (rows.length === 0) return [];

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

export interface GenerateOptions {
  matchNo?: number;
  seed?: number;
  /** 管理员手动指定参赛者；顺序即正选优先级。不给则按评分自动取 10 人 */
  playerIds?: string[];
  actor: LineupActor;
}

export interface GenerateResult {
  matchId: string;
  version: number;
  ratingGap: number;
  cost: number;
  warnings: BalanceWarning[];
  teams: BalanceResult['teams'];
}

/**
 * 生成（或重新生成）某一场的阵容。
 *
 * 只允许在"报名已关闭"之后：报名还是开放状态时名单会变，生成出来的分组没有意义。
 */
export async function generateMatchLineup(
  env: Env,
  event: { id: string; status: string },
  options: GenerateOptions,
): Promise<GenerateResult> {
  if (event.status !== 'REGISTRATION_CLOSED' && event.status !== 'PUBLISHED') {
    throw new ApiError('CONFLICT', '请先关闭报名再生成阵容');
  }

  const matchNo = options.matchNo ?? 1;
  const rows = await pickRoster(env, event.id, matchNo, options.playerIds);
  const seed = options.seed ?? 0;

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
        options.actor.id,
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

  return {
    matchId,
    version,
    ratingGap: result.ratingGap,
    cost: result.cost,
    warnings: result.warnings,
    teams: result.teams,
  };
}

/**
 * 发布阵容：校验两队各 5 人后把状态推到 PUBLISHED，并让赛事进入 PUBLISHED。
 * 发布之后阵容不能再改（PATCH lineup 只接受 DRAFT）。
 */
export async function publishMatch(
  env: Env,
  matchId: string,
  actor: LineupActor,
  requestId?: string | null,
): Promise<{ matchId: string; eventId: string; matchNo: number }> {
  const match = await env.DB.prepare(
    `SELECT id, event_id AS eventId, status, match_no AS matchNo FROM matches WHERE id = ?`,
  )
    .bind(matchId)
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
       VALUES (?, ?, ?, 'match.publish', 'match', ?, ?, ?, ?)`,
    ).bind(
      newId(now),
      actor.id,
      actor.role,
      match.id,
      JSON.stringify({ matchNo: match.matchNo, ratingGap: gap?.gap ?? null }),
      requestId ?? null,
      now,
    ),
  ]);

  return { matchId: match.id, eventId: match.eventId, matchNo: match.matchNo };
}
