import { Hono } from 'hono';
import { z } from 'zod';
import { ApiError, newId } from '@hive/shared';
import type { AppEnv, Env } from '../env';
import { requireAdmin } from '../guard';
import { countRegistrations, loadEvent, toEventView } from './events';
import { planFinalize, type FinalizePolicy } from '../services/roster';
import { recomputeEventRatings } from '../services/rating';
import { reorderWaitlist, sortWaitlist, type WaitlistPriorityRow } from '../services/waitlist';
import {
  assertPromotable,
  assertTitleEditable,
  planEventUpdate,
} from '../services/event-edit';

export const adminEventRoutes = new Hono<AppEnv>();

const isoDate = z.string().datetime({ offset: true });

const createEventSchema = z.object({
  title: z.string().trim().min(1).max(64),
  summary: z.string().trim().max(500).optional(),
  capacity: z
    .number()
    .int()
    .positive()
    .max(100)
    .refine((value) => value % 10 === 0, '容量必须是 10 的整数倍'),
  registrationOpensAt: isoDate.optional(),
  registrationClosesAt: isoDate.optional(),
  startsAt: isoDate.optional(),
  // 服务器：不传就是全球服（Steam 默认行为），国服要显式选
  serverRegion: z.enum(['CN', 'GLOBAL']).default('GLOBAL'),
});

/**
 * 编辑赛事。所有字段可选，但至少要给一个。
 * 时间字段允许显式传 null 表示"清空 / 回到待定"；路由里一律用 `=== undefined`
 * 区分"没传"和"传了 null"，不能用 falsy 判断。
 */
const updateEventSchema = z
  .object({
    title: z.string().trim().min(1).max(64).optional(),
    summary: z.string().trim().max(500).nullable().optional(),
    capacity: z
      .number()
      .int()
      .positive()
      .max(100)
      .refine((value) => value % 10 === 0, '容量必须是 10 的整数倍')
      .optional(),
    registrationOpensAt: isoDate.nullable().optional(),
    registrationClosesAt: isoDate.nullable().optional(),
    startsAt: isoDate.nullable().optional(),
    // 服务器随时可改（不影响任何已落库的决策），只有归档/取消后不能编辑
    serverRegion: z.enum(['CN', 'GLOBAL']).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, '至少要修改一个字段');

const transitionSchema = z.object({
  to: z.enum([
    'REGISTRATION_OPEN',
    'REGISTRATION_CLOSED',
    'PUBLISHED',
    'COMPLETED',
    'ARCHIVED',
    'CANCELLED',
  ]),
});

const finalizeSchema = z.object({
  policy: z.enum(['START_PARTIAL', 'EXTEND', 'CANCEL']).optional(),
  extendHours: z.number().int().min(1).max(72).optional(),
});

/** 合法状态流转白名单。非法流转一律 409，不做"尽力而为"的容错 */
const TRANSITIONS: Record<string, readonly string[]> = {
  DRAFT: ['REGISTRATION_OPEN', 'CANCELLED'],
  REGISTRATION_OPEN: ['REGISTRATION_CLOSED', 'CANCELLED'],
  REGISTRATION_CLOSED: ['REGISTRATION_OPEN', 'PUBLISHED', 'CANCELLED'],
  PUBLISHED: ['COMPLETED', 'CANCELLED'],
  COMPLETED: ['ARCHIVED'],
  ARCHIVED: [],
  CANCELLED: [],
};

async function audit(
  env: Env,
  entry: {
    actorId: string;
    action: string;
    entityType: string;
    entityId: string;
    before?: unknown;
    after?: unknown;
    reason?: string;
    requestId?: string;
  },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit_logs (id, actor_id, actor_role, action, entity_type, entity_id,
       before_json, after_json, reason, request_id, created_at)
     VALUES (?, ?, 'ADMIN', ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      newId(),
      entry.actorId,
      entry.action,
      entry.entityType,
      entry.entityId,
      entry.before === undefined ? null : JSON.stringify(entry.before),
      entry.after === undefined ? null : JSON.stringify(entry.after),
      entry.reason ?? null,
      entry.requestId ?? null,
      Date.now(),
    )
    .run();
}

/* -------------------------------------------------------------------------- */

adminEventRoutes.post('/', async (c) => {
  const adminId = requireAdmin(c);
  const parsed = createEventSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw new ApiError('VALIDATION_FAILED', '输入不合法', parsed.error.flatten().fieldErrors);
  }
  const input = parsed.data;
  const now = Date.now();
  const id = newId(now);

  const opensAt = input.registrationOpensAt ? Date.parse(input.registrationOpensAt) : null;
  const closesAt = input.registrationClosesAt ? Date.parse(input.registrationClosesAt) : null;
  if (opensAt !== null && closesAt !== null && closesAt <= opensAt) {
    throw new ApiError('VALIDATION_FAILED', '报名截止时间必须晚于开始时间');
  }

  await c.env.DB.prepare(
    `INSERT INTO events (id, title, summary, format, team_size, capacity, status,
       registration_opens_at, registration_closes_at, starts_at, server_region,
       created_by, created_at, updated_at)
     VALUES (?, ?, ?, 'DOTA2_5V5', 5, ?, 'DRAFT', ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      input.title,
      input.summary ?? null,
      input.capacity,
      opensAt,
      closesAt,
      input.startsAt ? Date.parse(input.startsAt) : null,
      input.serverRegion,
      adminId,
      now,
      now,
    )
    .run();

  await audit(c.env, {
    actorId: adminId,
    action: 'event.create',
    entityType: 'event',
    entityId: id,
    after: { title: input.title, capacity: input.capacity, serverRegion: input.serverRegion },
    requestId: c.get('requestId'),
  });

  return c.json({ data: toEventView(await loadEvent(c.env, id), { confirmed: 0, waitlist: 0 }) }, 201);
});

/* --------------------------------------------------------------------------
 * 编辑赛事：改错别字、改容量、改赛程
 * 容量只在 DRAFT / REGISTRATION_OPEN 可改，且不能低于已确认人数——
 * 封盘与分队都按当时的 capacity 做过决策，事后调小会让"目标人数"失去意义。
 * ------------------------------------------------------------------------ */
adminEventRoutes.patch('/:id', async (c) => {
  const env = c.env;
  const adminId = requireAdmin(c);
  const event = await loadEvent(env, c.req.param('id'));

  const parsed = updateEventSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw new ApiError('VALIDATION_FAILED', '输入不合法', parsed.error.flatten().fieldErrors);
  }
  const patch = parsed.data;

  if (patch.title !== undefined || patch.summary !== undefined || patch.serverRegion !== undefined) {
    assertTitleEditable(event);
  }

  const counts = await countRegistrations(env, event.id);
  // 传输层用 ISO 字符串，存储层用毫秒整数；undefined = 没传，null = 清空
  const toMs = (value: string | null | undefined): number | null | undefined =>
    value === undefined ? undefined : value === null ? null : Date.parse(value);
  const next = planEventUpdate(
    event,
    {
      title: patch.title,
      summary: patch.summary,
      capacity: patch.capacity,
      registrationOpensAt: toMs(patch.registrationOpensAt),
      registrationClosesAt: toMs(patch.registrationClosesAt),
      startsAt: toMs(patch.startsAt),
    },
    counts.confirmed,
  );

  const title = patch.title ?? event.title;
  const summary = patch.summary === undefined ? event.summary : patch.summary;
  // 服务器不属于赛程：归档/取消之外都能改，不需要等报名关闭
  const serverRegion = patch.serverRegion ?? event.server_region;
  const now = Date.now();

  await env.DB.prepare(
    `UPDATE events SET title = ?, summary = ?, capacity = ?,
       registration_opens_at = ?, registration_closes_at = ?, starts_at = ?,
       server_region = ?, updated_at = ?
     WHERE id = ?`,
  )
    .bind(
      title,
      summary,
      next.capacity,
      next.opensAt,
      next.closesAt,
      next.startsAt,
      serverRegion,
      now,
      event.id,
    )
    .run();

  await audit(env, {
    actorId: adminId,
    action: 'event.update',
    entityType: 'event',
    entityId: event.id,
    before: {
      title: event.title,
      summary: event.summary,
      capacity: event.capacity,
      registrationOpensAt: event.registration_opens_at,
      registrationClosesAt: event.registration_closes_at,
      startsAt: event.starts_at,
      serverRegion: event.server_region,
    },
    after: {
      title,
      summary,
      capacity: next.capacity,
      registrationOpensAt: next.opensAt,
      registrationClosesAt: next.closesAt,
      startsAt: next.startsAt,
      serverRegion,
    },
    requestId: c.get('requestId'),
  });

  const updated = await loadEvent(env, event.id);
  return c.json({ data: toEventView(updated, counts) });
});

adminEventRoutes.post('/:id/transition', async (c) => {
  const adminId = requireAdmin(c);
  const event = await loadEvent(c.env, c.req.param('id'));
  const parsed = transitionSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw new ApiError('VALIDATION_FAILED', '输入不合法', parsed.error.flatten().fieldErrors);
  }

  const target = parsed.data.to;
  const allowed = TRANSITIONS[event.status] ?? [];
  if (!allowed.includes(target)) {
    throw new ApiError('CONFLICT', `不允许从 ${event.status} 流转到 ${target}`);
  }

  const now = Date.now();
  await c.env.DB.prepare(`UPDATE events SET status = ?, updated_at = ? WHERE id = ?`)
    .bind(target, now, event.id)
    .run();

  await audit(c.env, {
    actorId: adminId,
    action: 'event.transition',
    entityType: 'event',
    entityId: event.id,
    before: { status: event.status },
    after: { status: target },
    requestId: c.get('requestId'),
  });

  // 赛事结束时出勤口径才成立（"报名且赛事已结束"），这里顺手重算相关玩家，
  // 不然出勤那 100 分要等管理员去评分页手动点「重算全部」
  if (target === 'COMPLETED') {
    await recomputeEventRatings(c.env, event.id);
  }

  const counts = await countRegistrations(c.env, event.id);
  return c.json({ data: toEventView({ ...event, status: target, updated_at: now }, counts) });
});

/* --------------------------------------------------------------------------
 * 封盘：报名关闭后一次性结算，决定开几场、谁进候补
 * ------------------------------------------------------------------------ */
adminEventRoutes.post('/:id/finalize', async (c) => {
  const env = c.env;
  const adminId = requireAdmin(c);
  const event = await loadEvent(env, c.req.param('id'));

  if (event.status !== 'REGISTRATION_CLOSED') {
    throw new ApiError('CONFLICT', '只有报名已关闭的赛事才能封盘');
  }

  const parsed = finalizeSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    throw new ApiError('VALIDATION_FAILED', '输入不合法', parsed.error.flatten().fieldErrors);
  }
  const policy = (parsed.data.policy ?? null) as FinalizePolicy | null;

  const counts = await countRegistrations(env, event.id);
  const autoFinalizeOdd = (c.env.AUTO_FINALIZE_ODD ?? 'false') === 'true';
  const decision = planFinalize(counts.confirmed, event.capacity, policy, autoFinalizeOdd);

  if (decision.outcome === 'INSUFFICIENT') {
    return c.json(
      {
        data: {
          outcome: decision.outcome,
          confirmed: counts.confirmed,
          message: '报名不足 10 人，无法开赛。请延期或取消赛事。',
        },
        meta: { requestId: c.get('requestId') },
      },
      200,
    );
  }

  if (decision.outcome === 'POLICY_REQUIRED') {
    throw new ApiError(
      'POLICY_REQUIRED',
      `当前 ${counts.confirmed} 人，可开 ${decision.matches} 场。请选择：按现有人数开局（余数进候补）或延长报名`,
      { confirmed: counts.confirmed, matches: decision.matches, capacity: event.capacity },
    );
  }

  const now = Date.now();
  let changed = 0;

  if (decision.outcome === 'START_PARTIAL') {
    // 顺序必须与 compareForSelection 一致：有段位 → 评分降序 → 报名时间升序 → id 升序。
    // 段位看的是**实时** player_stats，不是报名快照：报名后发现没填段位、补上了就该算数。
    const rows = await env.DB.prepare(
      `SELECT r.id FROM registrations r
         LEFT JOIN player_stats ps ON ps.user_id = r.user_id
        WHERE r.event_id = ? AND r.status = 'CONFIRMED'
        ORDER BY (CASE WHEN ps.rank_tier IS NOT NULL OR ps.declared_mmr IS NOT NULL THEN 1 ELSE 0 END) DESC,
                 r.effective_rating_snapshot DESC, r.created_at ASC, r.id ASC`,
    )
      .bind(event.id)
      .all<{ id: string }>();

    const benched = (rows.results ?? []).slice(decision.playCount);
    if (benched.length > 0) {
      const statements = benched.map((row, index) =>
        env.DB.prepare(
          `UPDATE registrations SET status = 'WAITLIST', waitlist_position = ?, updated_at = ?
            WHERE id = ? AND status = 'CONFIRMED'`,
        ).bind(index + 1, now, row.id),
      );
      // batch 是事务：要么全部进候补，要么一条都不动
      await env.DB.batch(statements);
      // 位置只是临时值；真正顺序由"出勤 → 实力 → 报名时间"决定
      await reorderWaitlist(env, event.id);
      changed = benched.length;
    }
  } else if (decision.outcome === 'EXTEND') {
    const hours = parsed.data.extendHours ?? 2;
    const base = event.registration_closes_at ?? now;
    const closesAt = Math.max(base, now) + hours * 60 * 60 * 1000;
    await env.DB.prepare(
      `UPDATE events SET status = 'REGISTRATION_OPEN', registration_closes_at = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(closesAt, now, event.id)
      .run();
    changed = 1;
  } else if (decision.outcome === 'CANCEL') {
    await env.DB.prepare(`UPDATE events SET status = 'CANCELLED', updated_at = ? WHERE id = ?`)
      .bind(now, event.id)
      .run();
    changed = 1;
  }

  await audit(env, {
    actorId: adminId,
    action: 'event.finalize',
    entityType: 'event',
    entityId: event.id,
    before: { confirmed: counts.confirmed, waitlist: counts.waitlist, status: event.status },
    after: { outcome: decision.outcome, playCount: decision.playCount, benchCount: decision.benchCount },
    reason: policy ?? undefined,
    requestId: c.get('requestId'),
  });

  const after = await countRegistrations(env, event.id);
  const updated = await loadEvent(env, event.id);

  return c.json({
    data: {
      outcome: decision.outcome,
      matches: decision.matches,
      playCount: decision.playCount,
      benchCount: decision.benchCount,
      changed,
      event: toEventView(updated, after),
    },
    meta: { requestId: c.get('requestId') },
  });
});

/* -------------------------------------------------------------------------- */
adminEventRoutes.get('/:id/registrations', async (c) => {
  requireAdmin(c);
  const event = await loadEvent(c.env, c.req.param('id'));

  const rows = await c.env.DB.prepare(
    `SELECT r.id, r.user_id AS userId, u.display_name AS displayName, u.username, u.role,
            r.status, r.position_preference AS position, r.waitlist_position AS waitlistPosition,
            r.effective_rating_snapshot AS effectiveRating, r.created_at AS createdAt,
            pr.attendance_bp AS attendanceBp,
            ps.rank_tier AS rankTier, ps.declared_mmr AS declaredMmr, ps.rank_source AS rankSource,
            ga.verification AS verification
       FROM registrations r
       JOIN users u ON u.id = r.user_id
       LEFT JOIN player_ratings pr ON pr.user_id = r.user_id
       LEFT JOIN player_stats ps ON ps.user_id = r.user_id
       LEFT JOIN game_accounts ga ON ga.user_id = r.user_id
      WHERE r.event_id = ?
      ORDER BY CASE r.status WHEN 'CONFIRMED' THEN 0 WHEN 'WAITLIST' THEN 1 ELSE 2 END,
               CASE WHEN r.status = 'WAITLIST' THEN r.waitlist_position END ASC,
               r.effective_rating_snapshot DESC, r.created_at ASC`,
  )
    .bind(event.id)
    .all();

  return c.json({
    data: {
      event: toEventView(event, await countRegistrations(c.env, event.id)),
      registrations: rows.results ?? [],
    },
    meta: { requestId: c.get('requestId') },
  });
});

/* --------------------------------------------------------------------------
 * 候补转正：把一个人从候补队列提到正选，并把后面的候补整体前移一位。
 * 正选人数受 capacity 约束——这是"目标人数"语义，不是座位数，所以不能无限转正。
 * ------------------------------------------------------------------------ */
adminEventRoutes.post('/:id/registrations/:rid/promote', async (c) => {
  const env = c.env;
  const adminId = requireAdmin(c);
  const event = await loadEvent(env, c.req.param('id'));

  const registration = await env.DB.prepare(
    `SELECT id, user_id AS userId, status, waitlist_position AS waitlistPosition
       FROM registrations WHERE id = ? AND event_id = ?`,
  )
    .bind(c.req.param('rid'), event.id)
    .first<{ id: string; userId: string; status: string; waitlistPosition: number | null }>();

  if (!registration) throw new ApiError('NOT_FOUND', '报名记录不存在');

  const counts = await countRegistrations(env, event.id);
  assertPromotable({
    eventStatus: event.status,
    registrationStatus: registration.status,
    confirmedCount: counts.confirmed,
    capacity: event.capacity,
  });

  const waitlistRows = await env.DB.prepare(
    `SELECT r.id,
            pr.attendance_bp AS attendanceBp,
            r.effective_rating_snapshot AS effectiveRating,
            r.created_at AS createdAt
       FROM registrations r
       LEFT JOIN player_ratings pr ON pr.user_id = r.user_id
      WHERE r.event_id = ? AND r.status = 'WAITLIST'`,
  )
    .bind(event.id)
    .all<WaitlistPriorityRow>();

  const remaining = sortWaitlist(
    (waitlistRows.results ?? []).filter((row) => row.id !== registration.id),
  ).map((row, index) => ({ id: row.id, position: index + 1 }));
  const now = Date.now();

  // 转正 + 重排必须在同一个事务里：否则中途失败会留下"两个 1 号候补"的队列
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE registrations SET status = 'CONFIRMED', waitlist_position = NULL, updated_at = ?
        WHERE id = ? AND status = 'WAITLIST'`,
    ).bind(now, registration.id),
    ...remaining.map((row) =>
      env.DB.prepare(`UPDATE registrations SET waitlist_position = ?, updated_at = ? WHERE id = ?`).bind(
        row.position,
        now,
        row.id,
      ),
    ),
  ]);

  await audit(env, {
    actorId: adminId,
    action: 'registration.promote',
    entityType: 'registration',
    entityId: registration.id,
    before: { status: 'WAITLIST', waitlistPosition: registration.waitlistPosition },
    after: { status: 'CONFIRMED', waitlistPosition: null },
    requestId: c.get('requestId'),
  });

  const after = await countRegistrations(env, event.id);
  return c.json({
    data: {
      registration: { id: registration.id, userId: registration.userId, status: 'CONFIRMED' },
      waitlist: remaining,
      event: toEventView(await loadEvent(env, event.id), after),
    },
    meta: { requestId: c.get('requestId') },
  });
});
