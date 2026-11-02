import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildAuthUrl,
  parseSteamId64,
  resolveOrigin,
  signState,
  toDotaAccountId,
  verifyCallback,
  verifyState,
  STEAM_OPENID_ENDPOINT,
} from './steam';

const SECRET = 'test-secret';

describe('state', () => {
  it('签名后能通过校验', async () => {
    const state = await signState(SECRET);
    await expect(verifyState(SECRET, state)).resolves.toBe(true);
  });

  it('换密钥后校验失败', async () => {
    const state = await signState(SECRET);
    await expect(verifyState('another-secret', state)).resolves.toBe(false);
  });

  it('篡改 nonce 会失败', async () => {
    const state = await signState(SECRET);
    const [, signature] = state.split('.');
    await expect(verifyState(SECRET, `tampered.${signature}`)).resolves.toBe(false);
  });

  it('每次生成的 state 都不同', async () => {
    const a = await signState(SECRET);
    const b = await signState(SECRET);
    expect(a).not.toBe(b);
  });

  it('空值或格式错误直接失败', async () => {
    await expect(verifyState(SECRET, null)).resolves.toBe(false);
    await expect(verifyState(SECRET, 'no-dot')).resolves.toBe(false);
  });
});

describe('buildAuthUrl', () => {
  it('指向 Steam 官方端点，且带上必要的 OpenID 参数', () => {
    const url = new URL(buildAuthUrl('https://hive.example.com', 'abc.def'));
    expect(url.origin + url.pathname).toBe(STEAM_OPENID_ENDPOINT);
    expect(url.searchParams.get('openid.mode')).toBe('checkid_setup');
    expect(url.searchParams.get('openid.realm')).toBe('https://hive.example.com');
    expect(url.searchParams.get('openid.return_to')).toBe(
      'https://hive.example.com/api/auth/steam/callback?state=abc.def',
    );
    expect(url.searchParams.get('openid.ns')).toBe('http://specs.openid.net/auth/2.0');
  });
});

describe('parseSteamId64', () => {
  it('从标准 claimed_id 中取出 17 位数字', () => {
    expect(parseSteamId64('https://steamcommunity.com/openid/id/76561198070168584')).toBe(
      '76561198070168584',
    );
  });

  it('拒绝非 Steam 域名、长度不对、带后缀的输入', () => {
    expect(parseSteamId64('https://evil.com/openid/id/76561198070168584')).toBeNull();
    expect(parseSteamId64('https://steamcommunity.com/openid/id/12345')).toBeNull();
    expect(parseSteamId64('https://steamcommunity.com/openid/id/76561198070168584/x')).toBeNull();
    expect(parseSteamId64(null)).toBeNull();
  });
});

describe('toDotaAccountId', () => {
  it('按固定差值得出 32 位账号 ID', () => {
    expect(toDotaAccountId('76561198070168584')).toBe(109902856);
  });

  it('超过 2^53 的数值仍然精确（必须用 BigInt）', () => {
    // 直接用 Number 相减会丢精度
    expect(76561198070168584 - 76561197960265728).not.toBe(109902856);
    expect(toDotaAccountId('76561198070168584')).toBe(109902856);
  });
});

describe('verifyCallback', () => {
  const ORIGIN = 'http://127.0.0.1:8787';

  function openidParams(overrides: Record<string, string> = {}): URLSearchParams {
    return new URLSearchParams({
      'openid.mode': 'id_res',
      'openid.op_endpoint': STEAM_OPENID_ENDPOINT,
      'openid.return_to': `${ORIGIN}/api/auth/steam/callback?state=abc.def`,
      'openid.claimed_id': 'https://steamcommunity.com/openid/id/76561198070168584',
      'openid.identity': 'https://steamcommunity.com/openid/id/76561198070168584',
      'openid.sig': 'deadbeef',
      ...overrides,
    });
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('return_to 前缀与传入的 origin 不一致时立刻失败，不发网络请求', async () => {
    // 这正是本地踩过的坑：wrangler dev 把请求 URL 改写成 routes 里的域名，
    // 若用 c.req.url 的 origin 去比对，Steam 回来后每次都在这里被判无效。
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const result = await verifyCallback({
      origin: ORIGIN,
      params: openidParams({ 'openid.return_to': 'http://hive.cwa1e.top/api/auth/steam/callback' }),
    });
    expect(result).toEqual({ ok: false, reason: 'return_to' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('op_endpoint 不是 Steam 官方地址时拒绝', async () => {
    const result = await verifyCallback({
      origin: ORIGIN,
      params: openidParams({ 'openid.op_endpoint': 'https://evil.example/login' }),
    });
    expect(result).toEqual({ ok: false, reason: 'endpoint' });
  });

  it('claimed_id 不是 17 位 SteamID 时拒绝', async () => {
    const result = await verifyCallback({
      origin: ORIGIN,
      params: openidParams({ 'openid.claimed_id': 'https://steamcommunity.com/openid/id/123' }),
    });
    expect(result).toEqual({ ok: false, reason: 'claimed_id' });
  });

  it('反向 POST 认了之后才放行，并取出 steamId64', async () => {
    const fetchMock = vi.fn(async () => new Response('ns:http://specs.openid.net/auth/2.0\nis_valid:true\n'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await verifyCallback({ origin: ORIGIN, params: openidParams() });

    expect(result).toEqual({ ok: true, steamId64: '76561198070168584' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(STEAM_OPENID_ENDPOINT);
    expect(init.method).toBe('POST');
    // 原样回传 openid.*，只把 mode 换成 check_authentication
    expect(String(init.body)).toContain('openid.mode=check_authentication');
    expect(String(init.body)).toContain('openid.sig=deadbeef');
  });

  it('Steam 返回 is_valid:false 时算失败', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('is_valid:false\n')));
    const result = await verifyCallback({ origin: ORIGIN, params: openidParams() });
    expect(result).toEqual({ ok: false, reason: 'not_valid' });
  });

  it('反向 POST 本身失败时也有明确的 reason', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 503 })));
    const result = await verifyCallback({ origin: ORIGIN, params: openidParams() });
    expect(result).toEqual({ ok: false, reason: 'post_failed' });
  });
});

describe('resolveOrigin', () => {
  it('配置了真实域名时优先用配置值', () => {
    // 注意不要用 example.com/org/net：它们是 RFC 2606 保留域名，会被当成占位值
    const resolved = resolveOrigin('https://hive.warroom.gg', 'http://127.0.0.1:8787/x');
    expect(resolved.source).toBe('config');
    expect(resolved.origin).toBe('https://hive.warroom.gg');
  });

  it('配置仍是占位域名时回退到请求 origin，并给出警告', () => {
    // 这正是踩过的坑：请求被 routes 改写成占位域名，Steam 跳回去是空响应
    const resolved = resolveOrigin('https://hive.example.com', 'https://real-host.dev/x');
    expect(resolved.source).toBe('request');
    expect(resolved.origin).toBe('https://real-host.dev');
    expect(resolved.warning).toContain('占位域名');
  });

  it('未配置时用请求 origin', () => {
    const resolved = resolveOrigin(undefined, 'http://127.0.0.1:8787/api/auth/steam/start');
    expect(resolved.origin).toBe('http://127.0.0.1:8787');
    expect(resolved.source).toBe('request');
  });

  it('配置不是合法 URL 时回退', () => {
    const resolved = resolveOrigin('not-a-url', 'http://127.0.0.1:8787/x');
    expect(resolved.origin).toBe('http://127.0.0.1:8787');
    expect(resolved.warning).toContain('不是合法 URL');
  });
});
