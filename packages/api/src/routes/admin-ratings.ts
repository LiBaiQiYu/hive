import { Hono } from 'hono';
import { z } from 'zod';
import { ApiError, newId } from '@hive/shared';
import type { AppEnv } from '../env';
import { requireAdmin } from '../guard';
import {
  ALGO_VERSION,
  MMR_TO_RATING_DIVISOR,
  adjustmentLimit,
  computeEffective,
  rankTierFromMmr,
} from '../algorithms/rating';
import { recomputeUserRating } from '../services/rating';
import { reorderOpenEventWaitlists } from '../services/waitlist';

export const adminRatingRoutes = new Hono<AppEnv>();

/** 天梯分的合理上限，与玩家手填接口共用同一口径 */
const MAX_MMR = 20_000;

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
            ps.rank_source AS rankSource,
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
    rankSource: string | null;
    updatedAt: number | null;
  }>();

  const players = (rows.results ?? []).map((row) => ({
    ...row,
    // 上限随置信度放宽，前端直接展示这个值，不要在页面里重算
    limit: adjustmentLimit(row.confidenceBp ?? 0),
  }));

  return c.json({ data: { players } });
});

/** GET /api/admin/ratings/players/:id/history —— 评分变更历史（append-only） */
adminRatingRoutes.get('/players/:id/history', async (c) => {
  requireAdmin(c);
  const userId = c.req.param('id');

  const adjustments = await c.env.DB.prepare(
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
    .bind(userId)
    .all<{
      id: string;
      oldAdjustment: number;
      newAdjustment: number;
      oldEffective: number;
      newEffective: number;
      reason: string;
      createdAt: number;
      operatorName: string | null;
    }>();

  /**
   * 设定天梯分也改评分，但它是"改输入值"而不是调修正，
   * rating_adjustments 的 CHECK（新旧修正必须不同）容不下它，所以单独取审计日志。
   * 两条来源在这里合并成一条时间线，页面只需要认 kind。
   */
  const mmrChanges = await c.env.DB.prepare(
    `SELECT a.id, a.before_json AS beforeJson, a.after_json AS afterJson,
            a.reason, a.created_at AS createdAt, u.display_name AS operatorName
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.actor_id
      WHERE a.action = 'rating.set-mmr' AND a.entity_id = ?
      ORDER BY a.created_at DESC
      LIMIT 50`,
  )
    .bind(userId)
    .all<{
      id: string;
      beforeJson: string | null;
      afterJson: string | null;
      reason: string | null;
      createdAt: number;
      operatorName: string | null;
    }>();

  const read = (raw: string | null) => {
    if (!raw) return null;
    try {
      return JSON.parse(raw) as { mmr?: number | null; effective?: number };
    } catch {
      return null;
    }
  };

  const history = [
    ...(adjustments.results ?? []).map((row) => ({ ...row, kind: 'ADJUSTMENT' as const })),
    ...(mmrChanges.results ?? []).map((row) => {
      const before = read(row.beforeJson);
      const after = read(row.afterJson);
      return {
        id: row.id,
        kind: 'MMR' as const,
        createdAt: row.createdAt,
        operatorName: row.operatorName,
        reason: row.reason ?? '',
        oldMmr: before?.mmr ?? null,
        newMmr: after?.mmr ?? null,
        oldEffective: before?.effective ?? 0,
        newEffective: after?.effective ?? 0,
      };
    }),
  ]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 50);

  return c.json({ data: { history } });
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

/* -------------------------------------------------------------------------- */
/**
 * PUT /api/admin/players/:id/declared-mmr
 *
 * 管理员直接设定玩家的**目标天梯分**，评分由系统按 MMR ÷ 10 重算。
 *
 * 为什么要这条路径：手填的天梯分是不可信的输入，有人填 20000 分就能把 WARROOM
 * 顶到 1000。旧的「修正值」接口要求管理员自己算差值（1000 → 300 就是 -700），
 * 既反直觉，也常常超过修正上限。这里改成纠正**输入本身**：
 *   · 写入 declared_mmr 与对应段位，来源记为 SELF_REPORTED（数据仍是自报性质）
 *   · 清零既有的人工修正，让最终分正好等于 round(MMR / 10)
 *   · 覆写前的天梯分、旧修正与旧分数都进历史与审计
 *
 * 同步来源（STRATZ / OPENDOTA）的段位不在这里改：下次同步会把它覆盖回去。
 */
const setMmrSchema = z.object({
  mmr: z.number().int().min(0).max(MAX_MMR),
  reason: z.string().trim().min(4).max(200),
});

adminRatingRoutes.put('/players/:id/declared-mmr', async (c) => {
  const adminId = requireAdmin(c);
  const env = c.env;
  const userId = c.req.param('id');

  const parsed = setMmrSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw new ApiError('VALIDATION_FAILED', '输入不合法', parsed.error.flatten().fieldErrors);
  }

  const stats = await env.DB.prepare(
    `SELECT rank_tier AS rankTier, declared_mmr AS declaredMmr, rank_source AS rankSource
       FROM player_stats WHERE user_id = ?`,
  )
    .bind(userId)
    .first<{ rankTier: number | null; declaredMmr: number | null; rankSource: string | null }>();
  if (!stats) throw new ApiError('NOT_FOUND', '该玩家还没有段位记录');

  if (stats.rankSource === 'STRATZ' || stats.rankSource === 'OPENDOTA') {
    throw new ApiError(
      'CONFLICT',
      '该玩家的段位来自第三方同步，改天梯分会在下次同步时被覆盖。请先让玩家解除绑定，或改用评分修正',
    );
  }

  const mmr = parsed.data.mmr;
  if (stats.declaredMmr === mmr && stats.rankSource === 'SELF_REPORTED') {
    throw new ApiError('CONFLICT', '天梯分没有变化');
  }

  const current = await env.DB.prepare(
    `SELECT system_rating AS system, admin_adjustment AS adjustment,
            effective_rating AS effective
       FROM player_ratings WHERE user_id = ?`,
  )
    .bind(userId)
    .first<{ system: number; adjustment: number; effective: number }>();

  const rankTier = rankTierFromMmr(mmr);
  // 评分是 MMR 的纯函数，这里直接算出结果，好让三处写入进同一个 batch（原子）
  const system = Math.min(1000, Math.max(0, Math.round(mmr / MMR_TO_RATING_DIVISOR)));
  const effective = computeEffective(system, 0);
  const oldAdjustment = current?.adjustment ?? 0;
  const oldEffective = current?.effective ?? system;
  const now = Date.now();
  const reason = `设定天梯分 ${stats.declaredMmr ?? '未填'} → ${mmr}：${parsed.data.reason}`;

  const statements = [
    env.DB.prepare(
      `UPDATE player_stats
          SET declared_mmr = ?, rank_tier = ?, rank_source = 'SELF_REPORTED',
              rank_checked_at = NULL, updated_at = ?
        WHERE user_id = ?`,
    ).bind(mmr, rankTier, now, userId),
    // 清零既有修正：管理员要给的是"最终就是这个分"，残留的 ±N 会让结果对不上。
    // system_rating 必须一起写：表上有 CHECK(effective = clamp(system + adjustment))，
    // 只改 effective 会撞约束。
    env.DB.prepare(
      `UPDATE player_ratings SET system_rating = ?, admin_adjustment = 0, effective_rating = ?,
         adjusted_by = ?, adjusted_at = ?, updated_at = ? WHERE user_id = ?`,
    ).bind(system, effective, adminId, now, now, userId),
  ];

  /**
   * 只有"确实清掉了旧修正"才写 rating_adjustments：
   * 表上有 CHECK (old_adjustment <> new_adjustment)，0 → 0 会被拒。
   * 单纯的改天梯分不需要这一行——它已经完整记在 audit_logs 里，
   * 历史接口会把两条来源合并成同一条时间线。
   */
  if (oldAdjustment !== 0) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO rating_adjustments (id, user_id, operator_id, old_adjustment, new_adjustment,
           old_effective, new_effective, reason, created_at)
         VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      ).bind(
        newId(now),
        userId,
        adminId,
        oldAdjustment,
        oldEffective,
        effective,
        reason.slice(0, 200),
        now,
      ),
    );
  }

  statements.push(
    env.DB.prepare(
      `INSERT INTO audit_logs (id, actor_id, actor_role, action, entity_type, entity_id,
         before_json, after_json, reason, request_id, created_at)
       VALUES (?, ?, 'ADMIN', 'rating.set-mmr', 'user', ?, ?, ?, ?, ?, ?)`,
    ).bind(
      newId(now),
      adminId,
      userId,
      JSON.stringify({
        mmr: stats.declaredMmr,
        rankTier: stats.rankTier,
        adjustment: oldAdjustment,
        effective: oldEffective,
      }),
      JSON.stringify({ mmr, rankTier, adjustment: 0, effective }),
      parsed.data.reason,
      c.get('requestId') ?? null,
      now,
    ),
  );

  await env.DB.batch(statements);

  // 补算置信度 / 出勤 / breakdown：这三项不是 MMR 的函数，得走统一入口
  const next = await recomputeUserRating(env, userId);
  await reorderOpenEventWaitlists(env);

  return c.json({
    data: {
      mmr,
      rankTier,
      system: next.system,
      adjustment: 0,
      effective: next.effective,
    },
  });
});
