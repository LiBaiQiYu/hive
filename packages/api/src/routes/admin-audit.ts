/**
 * 审计日志：只读。业务表只存当前状态，历史一律查这张表。
 *
 * 过滤条件全部可选：actorId / entityType / action / from / to / limit。
 */
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { requireAdmin } from '../guard';

export const adminAuditRoutes = new Hono<AppEnv>();

adminAuditRoutes.get('/', async (c) => {
  requireAdmin(c);

  const actorId = c.req.query('actorId');
  const entityType = c.req.query('entityType');
  const action = c.req.query('action');
  const from = Number.parseInt(c.req.query('from') ?? '', 10);
  const to = Number.parseInt(c.req.query('to') ?? '', 10);
  const limitRaw = Number.parseInt(c.req.query('limit') ?? '', 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;

  const where: string[] = [];
  const values: unknown[] = [];

  if (actorId) {
    where.push('a.actor_id = ?');
    values.push(actorId);
  }
  if (entityType) {
    where.push('a.entity_type = ?');
    values.push(entityType);
  }
  if (action) {
    where.push('a.action = ?');
    values.push(action);
  }
  if (Number.isFinite(from)) {
    where.push('a.created_at >= ?');
    values.push(from);
  }
  if (Number.isFinite(to)) {
    where.push('a.created_at <= ?');
    values.push(to);
  }

  const sql = `SELECT a.id, a.actor_id AS actorId, a.actor_role AS actorRole, a.action,
                      a.entity_type AS entityType, a.entity_id AS entityId,
                      a.before_json AS beforeJson, a.after_json AS afterJson,
                      a.reason, a.request_id AS requestId, a.created_at AS createdAt,
                      u.display_name AS actorName
                 FROM audit_logs a
                 LEFT JOIN users u ON u.id = a.actor_id
                ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                ORDER BY a.created_at DESC
                LIMIT ?`;

  const rows = await c.env.DB.prepare(sql)
    .bind(...values, limit)
    .all();

  // 过滤下拉用的候选值：动作类型与实体类型
  const facets = await c.env.DB.prepare(
    `SELECT 'action' AS kind, action AS value, count(*) AS count FROM audit_logs GROUP BY action
     UNION ALL
     SELECT 'entity' AS kind, entity_type AS value, count(*) AS count FROM audit_logs GROUP BY entity_type`,
  ).all<{ kind: string; value: string; count: number }>();

  return c.json({
    data: {
      entries: rows.results ?? [],
      actions: (facets.results ?? []).filter((row) => row.kind === 'action'),
      entityTypes: (facets.results ?? []).filter((row) => row.kind === 'entity'),
    },
    meta: { requestId: c.get('requestId') },
  });
});
