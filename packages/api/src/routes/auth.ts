import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { drizzle } from 'drizzle-orm/d1';
import { z } from 'zod';
import { playerRatings, users } from '@hive/db';
import { ApiError, newId, loginSchema, registerSchema, changePasswordSchema, SESSION_COOKIE } from '@hive/shared';
import type { AppEnv, Env } from '../env';
import { cookieSecure, intVar } from '../env';
import { requireUser } from '../guard';
import { hashPassword, verifyPassword } from '../password';
import { findValidReset } from '../services/password-reset';
import { createSession, hashIp, hashToken, readSession, revokeSession } from '../session';

export const authRoutes = new Hono<AppEnv>();

const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;

function iterations(env: Env): number {
  return intVar(env.PASSWORD_PBKDF2_ITERATIONS, 50000);
}

function setSessionCookie(c: Parameters<typeof setCookie>[0], env: Env, token: string, expiresAt: number) {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    // 只有 https 才加 Secure；本地 http://127.0.0.1 下加了会被浏览器丢弃，
    // 症状是"登录成功但仍然是未登录状态"
    secure: cookieSecure(env, c.req.url),
    sameSite: 'Lax',
    path: '/',
    expires: new Date(expiresAt),
  });
}

/* --------------------------------------------------------------------------
 * POST /api/auth/register
 * ------------------------------------------------------------------------ */
authRoutes.post('/register', async (c) => {
  const env = c.env;
  const parsed = registerSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw new ApiError('VALIDATION_FAILED', '输入不合法', parsed.error.flatten().fieldErrors);
  }
  const input = parsed.data;
  const now = Date.now();
  const db = drizzle(env.DB);

  // ---- 1) 邀请码：先确认可用的原因，再用带守卫的 UPDATE 原子消耗 ----
  const code = await env.DB.prepare(
    `SELECT id, max_uses AS maxUses, used_count AS usedCount,
            expires_at AS expiresAt, revoked_at AS revokedAt
       FROM invite_codes WHERE code = ?`,
  )
    .bind(input.inviteCode)
    .first<{ id: string; maxUses: number; usedCount: number; expiresAt: number | null; revokedAt: number | null }>();

  // 不区分"不存在 / 已撤销 / 已过期 / 已用尽"，避免被枚举出有效码
  if (!code) throw new ApiError('INVITE_INVALID', '邀请码不可用');
  if (code.revokedAt !== null) throw new ApiError('INVITE_INVALID', '邀请码不可用');
  if (code.expiresAt !== null && code.expiresAt <= now) throw new ApiError('INVITE_INVALID', '邀请码不可用');
  if (code.maxUses !== 0 && code.usedCount >= code.maxUses) throw new ApiError('INVITE_INVALID', '邀请码不可用');

  // 守卫条件写在 UPDATE 里，而不是"先 SELECT 再判断"——并发注册会超发
  const consumed = await env.DB.prepare(
    `UPDATE invite_codes SET used_count = used_count + 1, updated_at = ?
      WHERE id = ? AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > ?)
        AND (max_uses = 0 OR used_count < max_uses)`,
  )
    .bind(now, code.id, now)
    .run();

  if (!consumed.meta.changes) throw new ApiError('INVITE_INVALID', '邀请码不可用');

  // ---- 2) 预检重复，给出可读的错误而不是让唯一索引抛 500 ----
  const duplicate = await env.DB.prepare(
    `SELECT 1 AS hit FROM users WHERE username = ? OR email = ? LIMIT 1`,
  )
    .bind(input.username, input.email)
    .first<{ hit: number }>();

  if (duplicate) {
    await env.DB.prepare(`UPDATE invite_codes SET used_count = used_count - 1 WHERE id = ?`)
      .bind(code.id)
      .run();
    throw new ApiError('CONFLICT', '用户名或邮箱已被占用');
  }

  // ---- 3) 建号：users + player_ratings 必须原子写入 ----
  const userId = newId(now);
  const passwordHash = await hashPassword(input.password, env.PASSWORD_PEPPER, iterations(env));

  try {
    await db.batch([
      db.insert(users).values({
        id: userId,
        username: input.username,
        displayName: input.displayName,
        email: input.email,
        passwordHash,
        role: 'PLAYER',
        status: 'ACTIVE',
        inviteCodeId: code.id,
        // 注册即登录：不写这一列的话，后台「最近登录」对刚注册的人是「从未」——
        // 因为 last_login_at 只在 POST /auth/login 里更新，而注册后没人会立刻再登一次。
        lastLoginAt: now,
        createdAt: now,
        updatedAt: now,
      }),
      db.insert(playerRatings).values({
        id: newId(now),
        userId,
        systemRating: 500,
        adminAdjustment: 0,
        effectiveRating: 500,
        confidenceBp: 0,
        algorithmVersion: 'warroom-v1',
        updatedAt: now,
      }),
    ]);
  } catch (err) {
    // batch 是事务，失败时整批回滚；补偿邀请码的消耗
    await env.DB.prepare(`UPDATE invite_codes SET used_count = used_count - 1 WHERE id = ?`)
      .bind(code.id)
      .run();
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('UNIQUE')) throw new ApiError('CONFLICT', '用户名或邮箱已被占用');
    throw err;
  }

  // ---- 4) 直接登录 ----
  const ip = c.req.header('cf-connecting-ip') ?? null;
  const session = await createSession(env, userId, c.req.header('user-agent') ?? null, await hashIp(env, ip));
  setSessionCookie(c, env, session.token, session.expiresAt);

  return c.json(
    {
      data: {
        user: { id: userId, username: input.username, displayName: input.displayName, role: 'PLAYER' },
        expiresAt: new Date(session.expiresAt).toISOString(),
      },
      meta: { requestId: c.get('requestId') },
    },
    201,
  );
});

/* --------------------------------------------------------------------------
 * POST /api/auth/login
 * ------------------------------------------------------------------------ */
authRoutes.post('/login', async (c) => {
  const env = c.env;
  const parsed = loginSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw new ApiError('VALIDATION_FAILED', '输入不合法', parsed.error.flatten().fieldErrors);
  }
  const identifier = parsed.data.identifier.toLowerCase();
  const now = Date.now();

  const row = await env.DB.prepare(
    `SELECT id, username, display_name AS displayName, password_hash AS passwordHash,
            role, status, failed_login_count AS failedCount, locked_until AS lockedUntil
       FROM users WHERE username = ? OR email = ? LIMIT 1`,
  )
    .bind(identifier, identifier)
    .first<{
      id: string;
      username: string;
      displayName: string;
      passwordHash: string;
      role: 'PLAYER' | 'ADMIN';
      status: string;
      failedCount: number;
      lockedUntil: number | null;
    }>();

  // 用户不存在与密码错误返回同一个错误，避免枚举账号
  if (!row || row.status !== 'ACTIVE') throw new ApiError('UNAUTHENTICATED', '用户名或密码不正确');
  if (row.lockedUntil !== null && row.lockedUntil > now) {
    throw new ApiError('RATE_LIMITED', `尝试次数过多，请 ${LOCK_MINUTES} 分钟后再试`);
  }

  const verified = await verifyPassword(row.passwordHash, parsed.data.password, env.PASSWORD_PEPPER, iterations(env));

  if (!verified.ok) {
    const failed = row.failedCount + 1;
    const lockUntil = failed >= MAX_FAILED_LOGINS ? now + LOCK_MINUTES * 60 * 1000 : null;
    await env.DB.prepare(
      `UPDATE users SET failed_login_count = ?, locked_until = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(failed >= MAX_FAILED_LOGINS ? 0 : failed, lockUntil, now, row.id)
      .run();
    throw new ApiError('UNAUTHENTICATED', '用户名或密码不正确');
  }

  await env.DB.prepare(
    `UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(now, now, row.id)
    .run();

  // 迭代次数或算法落后的老哈希，在登录成功时静默升级
  if (verified.needsRehash) {
    const upgraded = await hashPassword(parsed.data.password, env.PASSWORD_PEPPER, iterations(env));
    await env.DB.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).bind(upgraded, row.id).run();
  }

  const ip = c.req.header('cf-connecting-ip') ?? null;
  const session = await createSession(env, row.id, c.req.header('user-agent') ?? null, await hashIp(env, ip));
  setSessionCookie(c, env, session.token, session.expiresAt);

  return c.json({
    data: {
      user: { id: row.id, username: row.username, displayName: row.displayName, role: row.role },
      expiresAt: new Date(session.expiresAt).toISOString(),
    },
    meta: { requestId: c.get('requestId') },
  });
});

/* --------------------------------------------------------------------------
 * POST /api/auth/password
 * 改密码 = 换掉所有旧 token 的效力：除了当前这台设备，其余会话一律撤销。
 * 不能"只改哈希不踢人"——密码泄露的场景下，攻击者的会话会一直活着。
 * ------------------------------------------------------------------------ */
authRoutes.post('/password', async (c) => {
  const env = c.env;
  const userId = requireUser(c);

  const parsed = changePasswordSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw new ApiError('VALIDATION_FAILED', '输入不合法', parsed.error.flatten().fieldErrors);
  }
  const { currentPassword, newPassword } = parsed.data;

  const row = await env.DB.prepare(
    `SELECT password_hash AS passwordHash FROM users WHERE id = ? AND status = 'ACTIVE'`,
  )
    .bind(userId)
    .first<{ passwordHash: string }>();
  if (!row) throw new ApiError('UNAUTHENTICATED', '会话已失效');

  const verified = await verifyPassword(
    row.passwordHash,
    currentPassword,
    env.PASSWORD_PEPPER,
    iterations(env),
  );
  if (!verified.ok) throw new ApiError('UNAUTHENTICATED', '当前密码不正确');
  if (newPassword === currentPassword) {
    throw new ApiError('VALIDATION_FAILED', '新密码不能与当前密码相同');
  }

  const passwordHash = await hashPassword(newPassword, env.PASSWORD_PEPPER, iterations(env));
  const now = Date.now();
  const token = getCookie(c, SESSION_COOKIE);
  const currentSessionId = token ? await hashToken(token) : null;

  // batch 是事务：密码与"踢掉其他设备"必须一起成功，否则会出现改了密码但旧会话仍可用
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE users SET password_hash = ?, failed_login_count = 0, locked_until = NULL, updated_at = ?
        WHERE id = ?`,
    ).bind(passwordHash, now, userId),
    currentSessionId
      ? env.DB.prepare(
          `UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id <> ? AND revoked_at IS NULL`,
        ).bind(now, userId, currentSessionId)
      : env.DB.prepare(`UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`).bind(
          now,
          userId,
        ),
  ]);

  return c.json({ data: { ok: true }, meta: { requestId: c.get('requestId') } });
});

/* --------------------------------------------------------------------------
 * GET /api/auth/reset-password/:token —— 链接是否还能用
 * 页面一进来先问一次：失效就直接显示"重新申请"，不要等用户输完密码才发现。
 * ------------------------------------------------------------------------ */
authRoutes.get('/reset-password/:token', async (c) => {
  const row = await findValidReset(c.env, c.req.param('token'));
  if (!row) return c.json({ data: { valid: false } });

  const user = await c.env.DB.prepare(
    `SELECT username, display_name AS displayName FROM users WHERE id = ?`,
  )
    .bind(row.userId)
    .first<{ username: string; displayName: string }>();

  // 令牌持有者本来就能改这个账号的密码，露出发给谁反而是必要的确认
  return c.json({
    data: {
      valid: true,
      expiresAt: row.expiresAt,
      username: user?.username ?? null,
      displayName: user?.displayName ?? null,
    },
  });
});

/* --------------------------------------------------------------------------
 * POST /api/auth/reset-password —— 用邮件里的令牌设置新密码
 * 一次性：成功后令牌作废，并把该账号所有会话踢下线（密码换了，旧会话不该继续有效）。
 * ------------------------------------------------------------------------ */
const resetPasswordSchema = z.object({
  token: z.string().min(16).max(128),
  newPassword: z.string().min(10, '密码至少 10 位').max(72, '密码最多 72 位'),
});

authRoutes.post('/reset-password', async (c) => {
  const env = c.env;

  const parsed = resetPasswordSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw new ApiError('VALIDATION_FAILED', '输入不合法', parsed.error.flatten().fieldErrors);
  }

  const row = await findValidReset(env, parsed.data.token);
  if (!row) throw new ApiError('UNAUTHENTICATED', '链接已失效，请重新发信申请');

  const target = await env.DB.prepare(
    `SELECT id, status FROM users WHERE id = ?`,
  )
    .bind(row.userId)
    .first<{ id: string; status: string }>();
  if (!target || target.status !== 'ACTIVE') {
    throw new ApiError('UNAUTHENTICATED', '账号不可用，请联系管理员');
  }

  const passwordHash = await hashPassword(parsed.data.newPassword, env.PASSWORD_PEPPER, iterations(env));
  const now = Date.now();

  // 改密码、踢会话、作废令牌必须原子：任何一步漏掉都留下"密码换了但旧会话还活着"的缝
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE users SET password_hash = ?, failed_login_count = 0, locked_until = NULL, updated_at = ?
        WHERE id = ?`,
    ).bind(passwordHash, now, row.userId),
    env.DB.prepare(
      `UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`,
    ).bind(now, row.userId),
    env.DB.prepare(`UPDATE password_resets SET used_at = ? WHERE id = ?`).bind(now, row.id),
    env.DB.prepare(
      `INSERT INTO audit_logs (id, actor_id, actor_role, action, entity_type, entity_id,
         after_json, request_id, created_at)
       VALUES (?, NULL, 'SYSTEM', 'user.password-reset-email', 'user', ?, ?, ?, ?)`,
    ).bind(
      newId(now),
      row.userId,
      JSON.stringify({ via: 'EMAIL_REPLY' }),
      c.get('requestId') ?? null,
      now,
    ),
  ]);

  return c.json({ data: { ok: true }, meta: { requestId: c.get('requestId') } });
});

/* --------------------------------------------------------------------------
 * POST /api/auth/logout
 * ------------------------------------------------------------------------ */
authRoutes.post('/logout', async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await revokeSession(c.env, token);
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.json({ data: { ok: true }, meta: { requestId: c.get('requestId') } });
});

/* --------------------------------------------------------------------------
 * GET /api/auth/session
 * ------------------------------------------------------------------------ */
authRoutes.get('/session', async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) throw new ApiError('UNAUTHENTICATED', '未登录');

  const session = await readSession(c.env, token);
  if (!session) throw new ApiError('UNAUTHENTICATED', '会话已失效');

  const user = await c.env.DB.prepare(
    `SELECT id, username, display_name AS displayName, role, status,
            qq_number AS qqNumber, avatar_url AS avatarUrl, created_at AS createdAt
       FROM users WHERE id = ?`,
  )
    .bind(session.userId)
    .first();

  return c.json({ data: { user }, meta: { requestId: c.get('requestId') } });
});
