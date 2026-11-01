/**
 * 成员管理：列表 + 授予/撤销管理员。
 *
 * 两条硬规则：
 *   · 不能改自己的角色（否则一个手滑就把最后一个管理员降级了）
 *   · 不能把最后一个管理员降级（社区会失去管理入口）
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { ApiError, newId } from '@hive/shared';
import type { AppEnv } from '../env';
import { requireAdmin } from '../guard';

export const adminUserRoutes = new Hono<AppEnv>();

adminUserRoutes.get('/', async (c) => {
  requireAdmin(c);

  const rows = await c.env.DB.prepare(
    `SELECT u.id, u.username, u.display_name AS displayName, u.role, u.status,
            u.qq_number AS qqNumber, u.created_at AS createdAt, u.last_login_at AS lastLoginAt,
            COALESCE(pr.effective_rating, 500) AS effective,
            (SELECT count(*) FROM registrations r WHERE r.user_id = u.id AND r.status = 'CONFIRMED') AS registrations,
            (SELECT count(*) FROM team_members tm WHERE tm.user_id = u.id AND tm.is_substitute = 0) AS appearances
       FROM users u
       LEFT JOIN player_ratings pr ON pr.user_id = u.id
      ORDER BY CASE u.role WHEN 'ADMIN' THEN 0 ELSE 1 END, u.created_at ASC`,
  ).all();

  return c.json({ data: { users: rows.results ?? [] } });
});

const roleSchema = z.object({
  role: z.enum(['PLAYER', 'ADMIN']),
});

adminUserRoutes.patch('/:id/role', async (c) => {
  const actorId = requireAdmin(c);
  const env = c.env;
  const userId = c.req.param('id');

  const parsed = roleSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw new ApiError('VALIDATION_FAILED', '输入不合法', parsed.error.flatten().fieldErrors);
  }
  if (userId === actorId) {
    throw new ApiError('CONFLICT', '不能修改自己的角色');
  }

  const target = await env.DB.prepare(
    `SELECT id, username, display_name AS displayName, role FROM users WHERE id = ?`,
  )
    .bind(userId)
    .first<{ id: string; username: string; displayName: string; role: 'PLAYER' | 'ADMIN' }>();
  if (!target) throw new ApiError('NOT_FOUND', '用户不存在');

  const nextRole = parsed.data.role;
  if (target.role === nextRole) {
    throw new ApiError('CONFLICT', `该用户已经是 ${nextRole === 'ADMIN' ? '管理员' : '普通玩家'}`);
  }

  if (nextRole === 'PLAYER') {
    const admins = await env.DB.prepare(
      `SELECT count(*) AS count FROM users WHERE role = 'ADMIN' AND status = 'ACTIVE'`,
    ).first<{ count: number }>();
    if ((admins?.count ?? 0) <= 1) {
      throw new ApiError('CONFLICT', '至少要保留一名管理员');
    }
  }

  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`UPDATE users SET role = ?, updated_at = ? WHERE id = ?`).bind(nextRole, now, target.id),
    env.DB.prepare(
      `INSERT INTO audit_logs (id, actor_id, actor_role, action, entity_type, entity_id,
         before_json, after_json, request_id, created_at)
       VALUES (?, ?, 'ADMIN', 'user.role', 'user', ?, ?, ?, ?, ?)`,
    ).bind(
      newId(now),
      actorId,
      target.id,
      JSON.stringify({ role: target.role }),
      JSON.stringify({ role: nextRole }),
      c.get('requestId') ?? null,
      now,
    ),
  ]);

  return c.json({
    data: { id: target.id, username: target.username, displayName: target.displayName, role: nextRole },
    meta: { requestId: c.get('requestId') },
  });
});
