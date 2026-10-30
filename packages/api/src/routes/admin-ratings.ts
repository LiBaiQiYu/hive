import { Hono } from 'hono';
import { z } from 'zod';
import { ApiError, newId } from '@hive/shared';
import type { AppEnv } from '../env';
import { requireAdmin } from '../guard';
import {
  ALGO_VERSION,
  adjustmentLimit,
  computeEffective,
  computeRating,
} from '../algorithms/rating';

export const adminRatingRoutes = new Hono<AppEnv>();

/**
 * GET /api/admin/ratings/players
 * 评分总表：按最终评分倒序，附带该玩家当前允许的修正上限。
 */
adminRatingRoutes.get('/players', async (c) => {
  requireAdmin(c);

  const rows = await c.env.DB.prepare(
    `SELECT u.id, u.username, u.display_name AS displayName, u.role,
            pr.system_rating AS system, pr.admin_adjustment AS adjustment,
            pr.effective_rating AS effective, pr.confidence_bp AS confidenceBp,
            ps.rank_tier AS rankTier, ps.declared_mmr AS declaredMmr,
            pr.updated_at AS updatedAt
       FROM users u
       LEFT JOIN player_ratings pr ON pr.user_id = u.id
       LEFT JOIN player_stats ps ON ps.user_id = u.id
      WHERE u.status = 'ACTIVE'
      ORDER BY COALESCE(pr.effective_rating, 0) DESC, u.username ASC`,
  ).all<{
    id: string;
    username: string;
    displayName: string;
    role: string;
    system: number | null;
    adjustment: number | null;
    effective: number | null;
    confidenceBp: number | null;
    rankTier: number | null;
    declaredMmr: number | null;
    updatedAt: number | null;
  }>();

  const players = (rows.results ?? []).map((row) => ({
    ...row,
    // 上限随置信度放宽，前端直接展示这个值，不要在页面里重算
    limit: adjustmentLimit(row.confidenceBp ?? 0),
  }));

  return c.json({ data: { players } });
});

/** GET /api/admin/ratings/players/:id/history —— 修正历史（append-only） */
adminRatingRoutes.get('/players/:id/history', async (c) => {
  requireAdmin(c);

  const rows = await c.env.DB.prepare(
    `SELECT ra.id, ra.old_adjustment AS oldAdjustment, ra.new_adjustment AS newAdjustment,
            ra.old_effective AS oldEffective, ra.new_effective AS newEffective,
            ra.reason, ra.created_at AS createdAt,
            u.display_name AS operatorName
       FROM rating_adjustments ra
       LEFT JOIN users u ON u.id = ra.operator_id
      WHERE ra.user_id = ?
      ORDER BY ra.created_at DESC
      LIMIT 50`,
  )
    .bind(c.req.param('id'))
    .all();

  return c.json({ data: { history: rows.results ?? [] } });
});

/** 汇总一个玩家的评分输入（缺数据的分项在算法里按 0 计并拉低置信度） */
export async function collectInput(env: AppEnv['Bindings'], userId: string) {
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

  // 出勤：报名过且赛事已结束 vs 真正上过场（正选，不含临时替补）
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

/**
 * POST /api/admin/ratings/recompute
 *
 * 重算全部（或指定）玩家的系统评分。
 * 只写 system_rating / effective_rating / breakdown，绝不碰 admin_adjustment——
 * 那是管理员的人工判断，重算不该把它抹掉。
 */
adminRatingRoutes.post('/recompute', async (c) => {
  const adminId = requireAdmin(c);
  const env = c.env;

  const body = (await c.req.json().catch(() => ({}))) as { userId?: string };

  const users = body.userId
    ? await env.DB.prepare(`SELECT id FROM users WHERE id = ?`).bind(body.userId).all<{ id: string }>()
    : await env.DB.prepare(`SELECT id FROM users WHERE status = 'ACTIVE'`).all<{ id: string }>();

  const now = Date.now();
  let updated = 0;
  const results: Array<{ userId: string; system: number; effective: number; confidenceBp: number }> = [];

  for (const user of users.results ?? []) {
    const input = await collectInput(env, user.id);
    const rating = computeRating(input);

    const current = await env.DB.prepare(
      `SELECT admin_adjustment AS adjustment FROM player_ratings WHERE user_id = ?`,
    )
      .bind(user.id)
      .first<{ adjustment: number }>();

    // 没有评分行就补一条（历史账号可能缺）
    if (!current) {
      await env.DB.prepare(
        `INSERT INTO player_ratings (id, user_id, system_rating, admin_adjustment, effective_rating,
           confidence_bp, algorithm_version, computed_at, updated_at)
         VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)`,
      )
        .bind(
          newId(now),
          user.id,
          rating.system,
          rating.system,
          rating.confidenceBp,
          ALGO_VERSION,
          now,
          now,
        )
        .run();
    } else {
      const effective = computeEffective(rating.system, current.adjustment);
      await env.DB.prepare(
        `UPDATE player_ratings
            SET system_rating = ?, effective_rating = ?, confidence_bp = ?,
                breakdown_json = ?, algorithm_version = ?, computed_at = ?, updated_at = ?
          WHERE user_id = ?`,
      )
        .bind(
          rating.system,
          effective,
          rating.confidenceBp,
          JSON.stringify({ components: rating.components, estimatedMmr: rating.estimatedMmr }),
          ALGO_VERSION,
          now,
          now,
          user.id,
        )
        .run();
    }

    updated += 1;
    results.push({
      userId: user.id,
      system: rating.system,
      effective: computeEffective(rating.system, current?.adjustment ?? 0),
      confidenceBp: rating.confidenceBp,
    });
  }

  await env.DB.prepare(
    `INSERT INTO audit_logs (id, actor_id, actor_role, action, entity_type, after_json, request_id, created_at)
     VALUES (?, ?, 'ADMIN', 'rating.recompute', 'player_ratings', ?, ?, ?)`,
  )
    .bind(newId(now), adminId, JSON.stringify({ updated, version: ALGO_VERSION }), c.get('requestId') ?? null, now)
    .run();

  return c.json({ data: { updated, algorithmVersion: ALGO_VERSION, results } });
});

/**
 * PUT /api/admin/players/:id/rating-adjustment
 *
 * 设置"新的修正值"（幂等，不是增量）。校验上限随置信度放宽，
 * 与前端展示的规则一致：150 + 350 × (1 − 置信度)。
 */
const adjustSchema = z.object({
  adjustment: z.number().int(),
  reason: z.string().trim().min(4).max(200),
  eventId: z.string().optional(),
});

adminRatingRoutes.put('/players/:id/rating-adjustment', async (c) => {
  const adminId = requireAdmin(c);
  const env = c.env;

  const parsed = adjustSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw new ApiError('VALIDATION_FAILED', '输入不合法', parsed.error.flatten().fieldErrors);
  }

  const row = await env.DB.prepare(
    `SELECT system_rating AS system, admin_adjustment AS adjustment,
            effective_rating AS effective, confidence_bp AS confidenceBp
       FROM player_ratings WHERE user_id = ?`,
  )
    .bind(c.req.param('id'))
    .first<{ system: number; adjustment: number; effective: number; confidenceBp: number }>();
  if (!row) throw new ApiError('NOT_FOUND', '该玩家还没有评分记录');

  const limit = adjustmentLimit(row.confidenceBp);
  if (Math.abs(parsed.data.adjustment) > limit) {
    throw new ApiError('VALIDATION_FAILED', `修正幅度需在 ±${limit} 之间（随数据置信度变化）`);
  }
  if (parsed.data.adjustment === row.adjustment) {
    throw new ApiError('CONFLICT', '修正值没有变化');
  }

  const now = Date.now();
  const effective = computeEffective(row.system, parsed.data.adjustment);

  // 三件事必须原子：改现值、记历史、写审计
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE player_ratings SET admin_adjustment = ?, effective_rating = ?,
         adjusted_by = ?, adjusted_at = ?, updated_at = ? WHERE user_id = ?`,
    ).bind(parsed.data.adjustment, effective, adminId, now, now, c.req.param('id')),
    env.DB.prepare(
      `INSERT INTO rating_adjustments (id, user_id, operator_id, old_adjustment, new_adjustment,
         old_effective, new_effective, reason, event_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      newId(now),
      c.req.param('id'),
      adminId,
      row.adjustment,
      parsed.data.adjustment,
      row.effective,
      effective,
      parsed.data.reason,
      parsed.data.eventId ?? null,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO audit_logs (id, actor_id, actor_role, action, entity_type, entity_id,
         before_json, after_json, reason, request_id, created_at)
       VALUES (?, ?, 'ADMIN', 'rating.adjust', 'user', ?, ?, ?, ?, ?, ?)`,
    ).bind(
      newId(now),
      adminId,
      c.req.param('id'),
      JSON.stringify({ adjustment: row.adjustment, effective: row.effective }),
      JSON.stringify({ adjustment: parsed.data.adjustment, effective }),
      parsed.data.reason,
      c.get('requestId') ?? null,
      now,
    ),
  ]);

  return c.json({
    data: {
      system: row.system,
      adjustment: parsed.data.adjustment,
      effective,
      limit,
    },
  });
});
