/**
 * Steam OpenID 2.0（不是 OAuth）
 *
 * 铁律：回调参数一律不可信，必须由服务端反向 POST 校验。
 * 六个校验点见 verifyCallback 的注释，缺任何一个都等于没做认证。
 */
export const STEAM_OPENID_ENDPOINT = 'https://steamcommunity.com/openid/login';
export const STEAM_STATE_COOKIE = 'hive_steam_state';
export const STATE_TTL_SECONDS = 600;

const CLAIMED_ID_PATTERN = /^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/;
/** STEAM64 与 DOTA account_id 的固定差值 */
const STEAM64_OFFSET = 76561197960265728n;

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
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

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

async function stateKey(secret: string): Promise<CryptoKey> {
  // 用独立的派生密钥，避免拿密码 pepper 直接当签名密钥用
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(`${secret}|steam-openid-state`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

/** 一次性 state：随机 nonce + HMAC 签名，存进 HttpOnly Cookie，不落库 */
export async function signState(secret: string): Promise<string> {
  const nonce = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
  const key = await stateKey(secret);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(nonce)));
  return `${nonce}.${toBase64Url(signature)}`;
}

export async function verifyState(secret: string, value: string | null): Promise<boolean> {
  if (!value) return false;
  const [nonce, signature] = value.split('.');
  if (!nonce || !signature) return false;

  const key = await stateKey(secret);
  const expected = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(nonce)));
  return timingSafeEqual(expected, fromBase64Url(signature));
}

/** 跳转到 Steam 的地址。state 放在 return_to 里，Steam 会原样带回来 */
export function buildAuthUrl(origin: string, state: string): string {
  const returnTo = `${origin}/api/auth/steam/callback?state=${encodeURIComponent(state)}`;
  const params = new URLSearchParams({
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'checkid_setup',
    'openid.return_to': returnTo,
    'openid.realm': origin,
    'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
    'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select',
  });
  return `${STEAM_OPENID_ENDPOINT}?${params.toString()}`;
}

/** 从 claimed_id 里取 SteamID64；不匹配一律 null（绝不"尽力解析"） */
export function parseSteamId64(claimedId: string | null): string | null {
  if (!claimedId) return null;
  const match = CLAIMED_ID_PATTERN.exec(claimedId);
  return match?.[1] ?? null;
}

/** DOTA account_id = steam_id64 − 76561197960265728（必须用 BigInt，JS Number 精度不够） */
export function toDotaAccountId(steamId64: string): number {
  return Number(BigInt(steamId64) - STEAM64_OFFSET);
}

export interface VerifyInput {
  origin: string;
  params: URLSearchParams;
}

/**
 * 服务端反向校验。
 * 依次检查：op_endpoint、return_to、claimed_id，最后把全部 openid.* 参数
 * 原样回传给 Steam 并确认返回体含 is_valid:true。
 */
export async function verifyCallback(input: VerifyInput): Promise<{ ok: boolean; steamId64?: string }> {
  const { origin, params } = input;

  const opEndpoint = params.get('openid.op_endpoint');
  if (opEndpoint !== STEAM_OPENID_ENDPOINT) return { ok: false };

  const returnTo = params.get('openid.return_to');
  const expectedPrefix = `${origin}/api/auth/steam/callback`;
  if (!returnTo || !returnTo.startsWith(expectedPrefix)) return { ok: false };

  const steamId64 = parseSteamId64(params.get('openid.claimed_id'));
  if (!steamId64) return { ok: false };

  // 反向 POST：原样回传，只把 mode 改成 check_authentication
  const body = new URLSearchParams();
  for (const [key, value] of params.entries()) {
    if (key.startsWith('openid.')) body.append(key, value);
  }
  body.set('openid.mode', 'check_authentication');

  const response = await fetch(STEAM_OPENID_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    redirect: 'manual',
  });
  if (!response.ok) return { ok: false };

  const text = await response.text();
  if (!/is_valid\s*:\s*true/i.test(text)) return { ok: false };

  return { ok: true, steamId64 };
}

/** 可选：用 Steam Web API 取昵称与头像。缺少 Key 时返回 null，不影响绑定 */
export async function fetchPersona(
  apiKey: string | undefined,
  steamId64: string,
): Promise<{ personaName: string | null; avatarUrl: string | null } | null> {
  if (!apiKey) return null;
  try {
    const url = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${encodeURIComponent(apiKey)}&steamids=${steamId64}`;
    const response = await fetch(url);
    if (!response.ok) return null;
    const data = (await response.json()) as {
      response?: { players?: Array<{ personaname?: string; avatarfull?: string }> };
    };
    const player = data.response?.players?.[0];
    return {
      personaName: player?.personaname ?? null,
      avatarUrl: player?.avatarfull ?? null,
    };
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */

/** example.com / .local 这类占位域名一律不信任——它们会被代理接管成假 IP */
const PLACEHOLDER_HOST = /(^|\.)(example\.(com|org|net)|localhost\.local)$/i;

export interface ResolvedOrigin {
  origin: string;
  source: 'config' | 'request';
  warning?: string;
}

/**
 * 决定 OpenID 的 realm 与 return_to 用哪个 origin。
 *
 * 为什么不直接用请求 origin：
 *   通过代理 / 隧道 / hosts 访问时，请求里的 Host 可能是 `hive.example.com` 这类占位域名，
 *   它解析到 Clash 的 fake-ip（198.18.x.x），Steam 跳回来时浏览器拿到空响应。
 *   优先用显式配置的 APP_ORIGIN，只有没配或配了占位域名时才回退到请求 origin。
 */
export function resolveOrigin(configured: string | undefined, requestUrl: string): ResolvedOrigin {
  const requestOrigin = new URL(requestUrl).origin;

  if (!configured) return { origin: requestOrigin, source: 'request' };

  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    return { origin: requestOrigin, source: 'request', warning: 'APP_ORIGIN 不是合法 URL' };
  }

  if (PLACEHOLDER_HOST.test(parsed.hostname)) {
    return {
      origin: requestOrigin,
      source: 'request',
      warning: 'APP_ORIGIN 仍是占位域名，已回退到请求 origin；Steam 回调可能无法返回',
    };
  }

  return { origin: parsed.origin, source: 'config' };
}

