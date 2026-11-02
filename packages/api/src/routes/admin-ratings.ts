import { Hono } from 'hono';
import { z } from 'zod';
import { ApiError, newId } from '@hive/shared';
import type { AppEnv } from '../env';
import { requireAdmin } from '../guard';
import { ALGO_VERSION, adjustmentLimit, computeEffective } from '../algorithms/rating';
import { recomputeUserRating } from '../services/rating';
import { reorderOpenEventWaitlists } from '../services/waitlist';

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
            pr.attendance_bp AS attendanceBp,
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
    attendanceBp: number | null;
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
  const results: Array<{
    userId: string;
    system: number;
    effective: number;
    confidenceBp: number;
    attendanceBp: number | null;
  }> = [];

  for (const user of users.results ?? []) {
    const rating = await recomputeUserRating(env, user.id);
    results.push({ userId: user.id, ...rating });
  }

  // 重算会刷新出勤率，仍在招募 / 待封盘赛事的候补队列要按新值重排
  await reorderOpenEventWaitlists(env);

  await env.DB.prepare(
    `INSERT INTO audit_logs (id, actor_id, actor_role, action, entity_type, after_json, request_id, created_at)
     VALUES (?, ?, 'ADMIN', 'rating.recompute', 'player_ratings', ?, ?, ?)`,
  )
    .bind(newId(now), adminId, JSON.stringify({ updated: results.length, version: ALGO_VERSION }), c.get('requestId') ?? null, now)
    .run();

  return c.json({ data: { updated: results.length, algorithmVersion: ALGO_VERSION, results } });
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
