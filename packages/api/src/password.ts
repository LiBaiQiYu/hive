/**
 * 密码哈希：PBKDF2-HMAC-SHA256 + 预先 HMAC 的 pepper。
 *
 * 存储格式（每个字段都可随记录升级）：
 *   pbkdf2_sha256$p1$<iterations>$<salt_b64url>$<hash_b64url>
 *
 * 为什么有 pepper：免费版每请求只有 10ms CPU，实测单次哈希的边界约 100,000 次迭代，
 * 我们取 50,000（≈4.8ms）。这个强度低于 OWASP 对 PBKDF2 的建议，
 * 所以再加一层只存在于 secret 里的 pepper——拿到 D1 备份也无法离线爆破。
 *
 * pepper 轮换：改 PASSWORD_PEPPER 会让所有密码失效，必须走双 pepper 过渡期，
 * 因此版本号（p1）写进哈希串，为将来的迁移留位置。
 */
const ALGORITHM = 'pbkdf2_sha256';
const PEPPER_VERSION = 'p1';
const SALT_BYTES = 16;
const KEY_BITS = 256;

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** 常数时间比较，避免通过响应时间推测哈希前缀 */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

async function pepperPassword(password: string, pepper: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(pepper),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(password));
  return new Uint8Array(signature);
}

async function derive(
  material: Uint8Array,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const baseKey = await crypto.subtle.importKey('raw', material, 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    baseKey,
    KEY_BITS,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(
  password: string,
  pepper: string,
  iterations: number,
): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const material = await pepperPassword(password, pepper);
  const hash = await derive(material, salt, iterations);
  return [
    ALGORITHM,
    PEPPER_VERSION,
    String(iterations),
    toBase64Url(salt),
    toBase64Url(hash),
  ].join('$');
}

export interface VerifyResult {
  ok: boolean;
  /** 迭代次数或 pepper 版本落后于当前配置时，登录成功后应静默重算 */
  needsRehash: boolean;
}

export async function verifyPassword(
  stored: string,
  password: string,
  pepper: string,
  currentIterations: number,
): Promise<VerifyResult> {
  const parts = stored.split('$');
  if (parts.length !== 5 || parts[0] !== ALGORITHM) return { ok: false, needsRehash: false };

  const [, version, rawIterations, rawSalt, rawHash] = parts;
  const iterations = Number.parseInt(rawIterations ?? '', 10);
  if (!Number.isFinite(iterations) || iterations <= 0) return { ok: false, needsRehash: false };
  if (version !== PEPPER_VERSION) return { ok: false, needsRehash: false };

  const salt = fromBase64Url(rawSalt ?? '');
  const expected = fromBase64Url(rawHash ?? '');
  const material = await pepperPassword(password, pepper);
  const actual = await derive(material, salt, iterations);

  return {
    ok: timingSafeEqual(actual, expected),
    needsRehash: iterations !== currentIterations,
  };
}
