/**
 * 密码重置令牌（邮件自助找回）。
 *
 * 链路：玩家用注册邮箱发信到 reset@ 域名 → Email Routing 交给 Worker 的 email()
 * → Worker 查库、生成一次性令牌、回信带链接 → 玩家在网页上设置新密码。
 *
 * 这里只放与运行环境无关的纯逻辑 + D1 读写；构造 MIME / 调 message.reply()
 * 的部分在 `email.ts`，因为那边要 import `cloudflare:email`，没法在本地单测里跑。
 */
import { newId } from '@hive/shared';
import type { Env } from '../env';

/** 令牌有效期：够点开邮件、改完密码，又不至于躺一整天 */
export const RESET_TTL_MINUTES = 30;
/** 同一账号每小时最多申请 3 次：防止有人用自动化脚本刷回信 */
export const RESET_MAX_PER_HOUR = 3;

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 32 字节随机令牌，base64url 后 43 个字符，写进邮件链接 */
export function randomResetToken(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/** 库里只存 sha256(token)，拿到数据库也换不出能用的链接 */
export async function hashResetToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(token));
  return toBase64Url(new Uint8Array(digest));
}

export interface CreatedReset {
  token: string;
  expiresAt: number;
}

/**
 * 生成一条新令牌。同一用户的旧令牌会被一并作废：
 * 邮箱里可能躺着好几封历史邮件，只有最新那一封能改密码才符合直觉。
 */
export async function createResetToken(
  env: Env,
  userId: string,
  now = Date.now(),
): Promise<CreatedReset> {
  const token = randomResetToken();
  const tokenHash = await hashResetToken(token);
  const expiresAt = now + RESET_TTL_MINUTES * 60 * 1000;

  await env.DB.batch([
    env.DB.prepare(`UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL`).bind(
      now,
      userId,
    ),
    env.DB.prepare(
      `INSERT INTO password_resets (id, user_id, token_hash, expires_at, used_at, created_at)
       VALUES (?, ?, ?, ?, NULL, ?)`,
    ).bind(newId(now), userId, tokenHash, expiresAt, now),
  ]);

  return { token, expiresAt };
}

export interface ResetRow {
  id: string;
  userId: string;
  expiresAt: number;
  usedAt: number | null;
}

/** 按明文令牌找一条**仍然有效**的记录；过期 / 已用 / 不存在都返回 null */
export async function findValidReset(
  env: Env,
  token: string,
  now = Date.now(),
): Promise<ResetRow | null> {
  if (!token) return null;
  const tokenHash = await hashResetToken(token);
  const row = await env.DB.prepare(
    `SELECT id, user_id AS userId, expires_at AS expiresAt, used_at AS usedAt
       FROM password_resets WHERE token_hash = ?`,
  )
    .bind(tokenHash)
    .first<ResetRow>();
  if (!row) return null;
  if (row.usedAt !== null || row.expiresAt <= now) return null;
  return row;
}

/** 最近一小时这个账号申请过几次 */
export async function recentResetCount(env: Env, userId: string, now = Date.now()): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT count(*) AS n FROM password_resets WHERE user_id = ? AND created_at > ?`,
  )
    .bind(userId, now - 60 * 60 * 1000)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** 重置链接用的正文。纯函数，方便单测钉住措辞与链接拼法 */
export function buildResetMail(input: {
  displayName: string;
  resetUrl: string;
  ttlMinutes: number;
}): { subject: string; text: string } {
  const subject = '[HIVE] 密码重置';
  const text = [
    `${input.displayName}，你好：`,
    '',
    '有人用这个邮箱申请了 HIVE 密码重置。点击下面的链接设置新密码：',
    '',
    input.resetUrl,
    '',
    `链接 ${input.ttlMinutes} 分钟内有效，且只能使用一次；设置成功后，其他设备上的登录会全部失效。`,
    '',
    '如果不是你本人操作，忽略这封邮件即可，你的密码不会被改动。',
    '',
    '—— HIVE（本邮件由系统自动回复，请勿直接回复）',
    '',
  ].join('\r\n');
  return { subject, text };
}
