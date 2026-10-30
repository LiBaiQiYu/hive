import { Hono } from 'hono';
import { z } from 'zod';
import { ApiError, newId } from '@hive/shared';
import type { AppEnv, Env } from '../env';
import { requireAdmin } from '../guard';
import { countRegistrations, loadEvent, toEventView } from './events';
import { planFinalize, type FinalizePolicy } from '../services/roster';

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
});

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
       registration_opens_at, registration_closes_at, starts_at, created_by, created_at, updated_at)
     VALUES (?, ?, ?, 'DOTA2_5V5', 5, ?, 'DRAFT', ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      input.title,
      input.summary ?? null,
      input.capacity,
      opensAt,
      closesAt,
      input.startsAt ? Date.parse(input.startsAt) : null,
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
    after: { title: input.title, capacity: input.capacity },
    requestId: c.get('requestId'),
  });

  return c.json({ data: toEventView(await loadEvent(c.env, id), { confirmed: 0, waitlist: 0 }) }, 201);
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
    // 顺序必须与 compareForSelection 一致：评分降序 → 报名时间升序 → id 升序
    const rows = await env.DB.prepare(
      `SELECT id FROM registrations
        WHERE event_id = ? AND status = 'CONFIRMED'
        ORDER BY effective_rating_snapshot DESC, created_at ASC, id ASC`,
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
    `SELECT r.id, r.user_id AS userId, u.display_name AS displayName, u.username,
            r.status, r.position_preference AS position, r.waitlist_position AS waitlistPosition,
            r.effective_rating_snapshot AS effectiveRating, r.created_at AS createdAt
       FROM registrations r JOIN users u ON u.id = r.user_id
      WHERE r.event_id = ?
      ORDER BY CASE r.status WHEN 'CONFIRMED' THEN 0 WHEN 'WAITLIST' THEN 1 ELSE 2 END,
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
