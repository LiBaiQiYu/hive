/**
 * 会话：不透明 token，库里只存 sha256(token)。
 *
 * 为什么不用 JWT：JWT 无法撤销。退出登录、改密码、踢人之后旧 token 仍然有效，
 * 这在"15 人小社区里有人换了号"的场景下会真的出问题。
 */
import type { Env } from './env';
import { intVar } from './env';

export interface SessionRecord {
  userId: string;
  role: 'PLAYER' | 'ADMIN';
}

const encoder = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** base64url 随机 token，32 字节熵 */
export function newSessionToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(token));
  return toHex(new Uint8Array(digest));
}

export function sessionTtlMs(env: Env): number {
  return intVar(env.SESSION_TTL_DAYS, 14) * 24 * 60 * 60 * 1000;
}

export function sessionIdleMs(env: Env): number {
  return intVar(env.SESSION_IDLE_TIMEOUT_HOURS, 72) * 60 * 60 * 1000;
}

export async function createSession(
  env: Env,
  userId: string,
  userAgent: string | null,
  ipHash: string | null,
): Promise<{ token: string; expiresAt: number }> {
  const token = newSessionToken();
  const id = await hashToken(token);
  const now = Date.now();
  const expiresAt = now + sessionTtlMs(env);

  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at, user_agent, ip_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, userId, now, expiresAt, now, userAgent?.slice(0, 256) ?? null, ipHash)
    .run();

  return { token, expiresAt };
}

/**
 * 校验会话并顺带滑动续期。
 * last_seen_at 每小时最多写一次——每次请求都写会让 D1 的写入量无谓翻倍。
 */
export async function readSession(env: Env, token: string): Promise<SessionRecord | null> {
  const id = await hashToken(token);
  const now = Date.now();

  const row = await env.DB.prepare(
    `SELECT s.user_id AS userId, u.role AS role, s.expires_at AS expiresAt,
            s.last_seen_at AS lastSeenAt
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND s.revoked_at IS NULL AND u.status = 'ACTIVE'`,
  )
    .bind(id)
    .first<{ userId: string; role: 'PLAYER' | 'ADMIN'; expiresAt: number; lastSeenAt: number }>();

  if (!row) return null;
  if (row.expiresAt <= now) return null;
  if (now - row.lastSeenAt > sessionIdleMs(env)) return null;

  if (now - row.lastSeenAt > 60 * 60 * 1000) {
    await env.DB.prepare(`UPDATE sessions SET last_seen_at = ? WHERE id = ?`).bind(now, id).run();
  }

  return { userId: row.userId, role: row.role };
}

export async function revokeSession(env: Env, token: string): Promise<void> {
  const id = await hashToken(token);
  await env.DB.prepare(`UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`)
    .bind(Date.now(), id)
    .run();
}

export async function revokeAllSessions(env: Env, userId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`,
  )
    .bind(Date.now(), userId)
    .run();
}

/** 隐私：不存原始 IP，只存加盐哈希（盐每日轮换） */
export async function hashIp(env: Env, ip: string | null): Promise<string | null> {
  if (!ip) return null;
  const day = new Date().toISOString().slice(0, 10);
  const digest = await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(`${ip}|${env.IP_HASH_SALT}|${day}`),
  );
  return toHex(new Uint8Array(digest));
}
