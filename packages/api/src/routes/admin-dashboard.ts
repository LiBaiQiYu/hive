/**
 * 后台仪表盘：一屏看清"现在有多少人、多少场、多少事等着做"。
 *
 * 只做聚合读，不写库；所有数字都从现有表现算，不额外维护统计表
 * （15 人的社区，实时算比维护缓存更不容易出错）。
 */
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { requireAdmin } from '../guard';

export const adminDashboardRoutes = new Hono<AppEnv>();

adminDashboardRoutes.get('/', async (c) => {
  requireAdmin(c);

  const now = Date.now();
  const monthStart = new Date(new Date(now).getFullYear(), new Date(now).getMonth(), 1).getTime();

  const [members, events, registrations, pending, jobs, recent] = await Promise.all([
    c.env.DB.prepare(
      `SELECT
         (SELECT count(*) FROM users WHERE status = 'ACTIVE') AS active,
         (SELECT count(*) FROM users WHERE status = 'ACTIVE' AND role = 'ADMIN') AS admins,
         (SELECT count(*) FROM users WHERE created_at >= ?) AS newThisMonth`,
    )
      .bind(monthStart)
      .first<{ active: number; admins: number; newThisMonth: number }>(),

    c.env.DB.prepare(
      `SELECT
         (SELECT count(*) FROM events WHERE status IN ('REGISTRATION_OPEN', 'REGISTRATION_CLOSED')) AS ongoing,
         (SELECT count(*) FROM events) AS total,
         (SELECT count(*) FROM events WHERE status = 'REGISTRATION_OPEN') AS openNow`,
    ).first<{ ongoing: number; total: number; openNow: number }>(),

    c.env.DB.prepare(
      `SELECT count(*) AS thisMonth FROM registrations WHERE created_at >= ?`,
    )
      .bind(monthStart)
      .first<{ thisMonth: number }>(),

    // 待发布 = 已封盘但还没有任何一场 PUBLISHED 的赛事，需要管理员去分队/发布
    c.env.DB.prepare(
      `SELECT count(*) AS count FROM events e
        WHERE e.status = 'REGISTRATION_CLOSED'
          AND NOT EXISTS (SELECT 1 FROM matches m WHERE m.event_id = e.id AND m.status = 'PUBLISHED')`,
    ).first<{ count: number }>(),

    c.env.DB.prepare(
      `SELECT
         (SELECT count(*) FROM sync_jobs WHERE status = 'PENDING') AS pending,
         (SELECT count(*) FROM sync_jobs WHERE status = 'RUNNING') AS running,
         (SELECT count(*) FROM sync_jobs WHERE status = 'DEAD') AS dead,
         (SELECT count(*) FROM sync_jobs WHERE status = 'FAILED') AS failed`,
    ).first<{ pending: number; running: number; dead: number; failed: number }>(),

    c.env.DB.prepare(
      `SELECT e.id, e.title, e.status, e.capacity, e.starts_at AS startsAt,
              (SELECT count(*) FROM registrations r WHERE r.event_id = e.id AND r.status = 'CONFIRMED') AS confirmed
         FROM events e
        ORDER BY COALESCE(e.starts_at, e.created_at) DESC
        LIMIT 5`,
    ).all<{ id: string; title: string; status: string; capacity: number; startsAt: number | null; confirmed: number }>(),
  ]);

  return c.json({
    data: {
      members: members ?? { active: 0, admins: 0, newThisMonth: 0 },
      events: events ?? { ongoing: 0, total: 0, openNow: 0 },
      registrations: registrations ?? { thisMonth: 0 },
      pendingPublish: pending?.count ?? 0,
      jobs: jobs ?? { pending: 0, running: 0, dead: 0, failed: 0 },
      recentEvents: recent.results ?? [],
    },
    meta: { requestId: c.get('requestId') },
  });
});
