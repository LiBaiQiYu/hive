import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { drizzle } from 'drizzle-orm/d1';
import { playerRatings, users } from '@hive/db';
import { ApiError, newId, loginSchema, registerSchema, changePasswordSchema, SESSION_COOKIE } from '@hive/shared';
import type { AppEnv, Env } from '../env';
import { intVar } from '../env';
import { requireUser } from '../guard';
import { hashPassword, verifyPassword } from '../password';
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
    // localhost 在主流浏览器里属于安全上下文，本地开发也能带上 Secure Cookie
    secure: true,
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
