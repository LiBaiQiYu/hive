/**
 * 评分重算：把「算一个人」这件事收敛到一处。
 *
 * 以前这段逻辑散在三处（管理员重算、改段位、OpenDota 同步），
 * 改一个字段要改三遍，很容易出现"某条路径忘了写 breakdown"的漂移。
 */
import { newId } from '@hive/shared';
import {
  ALGO_VERSION,
  computeEffective,
  computeRating,
  type RatingInput,
} from '../algorithms/rating';
import type { Env } from '../env';

/**
 * 汇总一个玩家的评分输入。
 *
 * 出勤口径：报名过、且赛事已经结束（COMPLETED）的场次 vs 真正上过场
 * （正选，不含临时替补，且那场比赛已结束）。
 */
export async function collectInput(env: Env, userId: string): Promise<RatingInput> {
  const stats = await env.DB.prepare(
    `SELECT rank_tier AS rankTier, declared_mmr AS declaredMmr, rank_source AS rankSource,
            career_matches AS careerMatches
       FROM player_stats WHERE user_id = ?`,
  )
    .bind(userId)
    .first<{
      rankTier: number | null;
      declaredMmr: number | null;
      rankSource: string | null;
      careerMatches: number;
    }>();

  const attendance = await env.DB.prepare(
    `SELECT
       (SELECT count(*) FROM registrations r JOIN events e ON e.id = r.event_id
         WHERE r.user_id = ?1 AND r.status = 'CONFIRMED'
           AND e.status IN ('COMPLETED')) AS registered,
       (SELECT count(*) FROM team_members tm JOIN matches m ON m.id = tm.match_id
         WHERE tm.user_id = ?1 AND tm.is_substitute = 0 AND m.status = 'COMPLETED') AS played`,
  )
    .bind(userId)
    .first<{ registered: number; played: number }>();

  return {
    rankTier: stats?.rankTier ?? null,
    /**
     * MMR 只在"玩家自己申报"时才参与计算。
     * 一旦段位来自 OpenDota / 管理员设定，它就是权威值——否则会出现
     * "同步了超凡 1 星，却按之前手填的 5799 分算"的错配。
     */
    declaredMmr: stats?.rankSource === 'SELF_REPORTED' ? (stats.declaredMmr ?? null) : null,
    careerMatches: stats?.careerMatches ?? 0,
    communityRegistered: attendance?.registered ?? 0,
    communityPlayed: attendance?.played ?? 0,
  };
}

export interface RecomputeResult {
  system: number;
  effective: number;
  confidenceBp: number;
}

/**
 * 重算一个人的系统分。
 * 只动 system_rating / effective_rating / confidence_bp / breakdown，
 * **绝不碰 admin_adjustment** —— 那是管理员的人工判断，重算不该抹掉它。
 */
export async function recomputeUserRating(env: Env, userId: string): Promise<RecomputeResult> {
  const input = await collectInput(env, userId);
  const rating = computeRating(input);

  const current = await env.DB.prepare(
    `SELECT admin_adjustment AS adjustment FROM player_ratings WHERE user_id = ?`,
  )
    .bind(userId)
    .first<{ adjustment: number }>();

  const adjustment = current?.adjustment ?? 0;
  const effective = computeEffective(rating.system, adjustment);
  const now = Date.now();
  const breakdown = JSON.stringify({
    components: rating.components,
    estimatedMmr: rating.estimatedMmr,
    attendanceBp: rating.attendanceBp,
  });

  if (!current) {
    // 历史账号可能没有评分行，补一条
    await env.DB.prepare(
      `INSERT INTO player_ratings (id, user_id, system_rating, admin_adjustment, effective_rating,
         confidence_bp, breakdown_json, algorithm_version, computed_at, updated_at)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        newId(now),
        userId,
        rating.system,
        effective,
        rating.confidenceBp,
        breakdown,
        ALGO_VERSION,
        now,
        now,
      )
      .run();
  } else {
    await env.DB.prepare(
      `UPDATE player_ratings
          SET system_rating = ?, effective_rating = ?, confidence_bp = ?, breakdown_json = ?,
              algorithm_version = ?, computed_at = ?, updated_at = ?
        WHERE user_id = ?`,
    )
      .bind(
        rating.system,
        effective,
        rating.confidenceBp,
        breakdown,
        ALGO_VERSION,
        now,
        now,
        userId,
      )
      .run();
  }

  return { system: rating.system, effective, confidenceBp: rating.confidenceBp };
}

/**
 * 重算一场赛事相关的所有玩家。
 *
 * 触发点：录入比赛结果、赛事转 COMPLETED。
 * 这两件事都会改变出勤口径（上场场次 / 报名且已结束的场次），
 * 不重算的话出勤那 100 分会一直停在旧值。
 */
export async function recomputeEventRatings(env: Env, eventId: string): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT user_id AS userId FROM registrations WHERE event_id = ?1
     UNION
     SELECT tm.user_id AS userId FROM team_members tm
       JOIN matches m ON m.id = tm.match_id
      WHERE m.event_id = ?1`,
  )
    .bind(eventId)
    .all<{ userId: string }>();

  const users = rows.results ?? [];
  for (const row of users) {
    await recomputeUserRating(env, row.userId);
  }
  return users.length;
}
