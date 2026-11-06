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
import { intVar } from '../env';
import { requireAdmin } from '../guard';
import { generateTempPassword, hashPassword } from '../password';

export const adminUserRoutes = new Hono<AppEnv>();

adminUserRoutes.get('/', async (c) => {
  requireAdmin(c);

  const rows = await c.env.DB.prepare(
    `SELECT u.id, u.username, u.display_name AS displayName, u.role, u.status,
            u.qq_number AS qqNumber, u.created_at AS createdAt, u.last_login_at AS lastLoginAt,
            COALESCE(pr.effective_rating, 500) AS effective,
            ps.rank_tier AS rankTier, ps.declared_mmr AS declaredMmr, ps.rank_source AS rankSource,
            ga.verification AS verification,
            (SELECT count(*) FROM registrations r WHERE r.user_id = u.id AND r.status = 'CONFIRMED') AS registrations,
            (SELECT count(*) FROM team_members tm WHERE tm.user_id = u.id AND tm.is_substitute = 0) AS appearances
       FROM users u
       LEFT JOIN player_ratings pr ON pr.user_id = u.id
       LEFT JOIN player_stats ps ON ps.user_id = u.id
       LEFT JOIN game_accounts ga ON ga.user_id = u.id
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

/* -------------------------------------------------------------------------- */
/**
 * POST /api/admin/users/:id/reset-password
 *
 * 社区的"忘记密码"通道：没有邮件服务（免费版也发不了信），所以由管理员
 * 生成一次性临时口令、当面或在群里转交给本人，本人登录后到「账号设置」改掉。
 *
 * 三条约束：
 *   · 不能重置自己（自己的密码走「账号设置」，避免管理员把自己锁在外面）
 *   · 临时口令只出现在这一次响应里，**不写审计日志**（日志只记会话作废与操作人）
 *   · 顺带清空失败次数与锁定时间，否则刚重置完仍会被锁 15 分钟
 */
adminUserRoutes.post('/:id/reset-password', async (c) => {
  const actorId = requireAdmin(c);
  const env = c.env;
  const userId = c.req.param('id');

  if (userId === actorId) {
    throw new ApiError('CONFLICT', '不能重置自己的密码，请用「账号设置」修改');
  }

  const target = await env.DB.prepare(
    `SELECT id, username, display_name AS displayName, status FROM users WHERE id = ?`,
  )
    .bind(userId)
    .first<{ id: string; username: string; displayName: string; status: string }>();
  if (!target) throw new ApiError('NOT_FOUND', '用户不存在');
  if (target.status !== 'ACTIVE') throw new ApiError('CONFLICT', '该账号已停用');

  const password = generateTempPassword();
  const passwordHash = await hashPassword(
    password,
    env.PASSWORD_PEPPER,
    intVar(env.PASSWORD_PBKDF2_ITERATIONS, 50000),
  );

  const active = await env.DB.prepare(
    `SELECT count(*) AS count FROM sessions WHERE user_id = ? AND revoked_at IS NULL`,
  )
    .bind(userId)
    .first<{ count: number }>();

  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE users
          SET password_hash = ?, failed_login_count = 0, locked_until = NULL, updated_at = ?
        WHERE id = ?`,
    ).bind(passwordHash, now, userId),
    // 旧会话必须一起作废，否则拿到临时口令也踢不掉已经在别处登录的设备
    env.DB.prepare(
      `UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`,
    ).bind(now, userId),
    env.DB.prepare(
      `INSERT INTO audit_logs (id, actor_id, actor_role, action, entity_type, entity_id,
         after_json, request_id, created_at)
       VALUES (?, ?, 'ADMIN', 'user.password-reset', 'user', ?, ?, ?, ?)`,
    ).bind(
      newId(now),
      actorId,
      target.id,
      JSON.stringify({ sessionsRevoked: active?.count ?? 0 }),
      c.get('requestId') ?? null,
      now,
    ),
  ]);

  return c.json({
    data: {
      id: target.id,
      username: target.username,
      displayName: target.displayName,
      // 只在这里出现一次；管理员转交后就让本人改掉
      password,
      sessionsRevoked: active?.count ?? 0,
    },
  });
});
