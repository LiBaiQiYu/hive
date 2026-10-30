import { z } from 'zod';

/* ==========================================================================
 * ID
 * ========================================================================== */

/**
 * UUIDv7：前 48 位是毫秒时间戳，其余随机。时间序 → SQLite B+Tree 写入局部性好，
 * 且不像自增 ID 那样泄露社区规模。
 */
export function newId(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  const ts = BigInt(now);
  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70; // version 7
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // RFC 4122 variant

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/* ==========================================================================
 * 错误
 * ========================================================================== */

export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'INVITE_INVALID',
  'POLICY_REQUIRED',
  'RATE_LIMITED',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  INVITE_INVALID: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  POLICY_REQUIRED: 422,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get status(): number {
    return STATUS[this.code];
  }
}

/* ==========================================================================
 * 输入校验
 * ========================================================================== */

/** 用户名一律小写规范化，与数据库的 CHECK (username = lower(username)) 对齐 */
export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_]{3,24}$/, '用户名需 3-24 位，仅限小写字母、数字与下划线');

export const registerSchema = z.object({
  username: usernameSchema,
  displayName: z.string().trim().min(1).max(32),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(10, '密码至少 10 位').max(72),
  inviteCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9-]{6,16}$/, '邀请码格式不正确'),
});

export const loginSchema = z.object({
  identifier: z.string().trim().min(1),
  password: z.string().min(1).max(72),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;

/* ==========================================================================
 * 常量
 * ========================================================================== */

/** 与数据库 sessions.id 的语义一致：库里只存 token 的 sha256 */
export const SESSION_COOKIE = 'hive_session';
export const CSRF_HEADER = 'x-hive-csrf';
export const CSRF_COOKIE = 'hive_csrf';
