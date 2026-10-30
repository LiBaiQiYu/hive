import { describe, expect, it } from 'vitest';
import {
  buildAuthUrl,
  parseSteamId64,
  resolveOrigin,
  signState,
  toDotaAccountId,
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
