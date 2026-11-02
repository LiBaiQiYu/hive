/**
 * STRATZ 响应解析的守门人。
 *
 * 这条链路没有自动化联调（要真 token 才能打），所以把"我们依赖哪些字段、
 * 拿到脏数据怎么办"钉在单测里：字段名写错、rank 越界、GraphQL 报错
 * 这几种情况必须在解析层就暴露，而不是让用户看到"同步成功但段位是 0"。
 */
import { describe, expect, it } from 'vitest';
import { ApiError } from '@hive/shared';
import type { Env } from './env';
import { fetchRankSnapshot, parseStratzPayload } from './services/rank-provider';

const OK_PAYLOAD = {
  data: {
    player: {
      steamAccount: { id: 699433735, name: 'ChatGPT', avatar: 'https://cdn.stratz.com/x.jpg' },
      ranks: [{ rank: 53 }],
    },
  },
};

describe('STRATZ 段位解析', () => {
  it('取出昵称、头像与段位编码', () => {
    expect(parseStratzPayload(OK_PAYLOAD)).toEqual({
      personaName: 'ChatGPT',
      avatarUrl: 'https://cdn.stratz.com/x.jpg',
      rankTier: 53,
    });
  });

  it('冠绝（80）也照原样返回', () => {
    const payload = {
      data: { player: { steamAccount: { id: 1, name: null, avatar: null }, ranks: [{ rank: 80 }] } },
    };
    expect(parseStratzPayload(payload)?.rankTier).toBe(80);
  });

  it('没公开段位时 rank 为 0 或 null → 当作没有数据，且不报错', () => {
    expect(
      parseStratzPayload({
        data: { player: { steamAccount: { id: 1, name: 'x', avatar: null }, ranks: [{ rank: 0 }] } },
      })?.rankTier,
    ).toBeNull();
    expect(
      parseStratzPayload({
        data: { player: { steamAccount: { id: 1, name: 'x', avatar: null }, ranks: null } },
      })?.rankTier,
    ).toBeNull();
  });

  it('越界的 rank 不采信（宁可不显示，也不显示一个错段位）', () => {
    for (const rank of [5, 86, 999]) {
      expect(
        parseStratzPayload({
          data: { player: { steamAccount: { id: 1, name: 'x', avatar: null }, ranks: [{ rank }] } },
        })?.rankTier,
      ).toBeNull();
    }
  });

  it('查无此人（player 为 null 且没有 errors）→ 返回 null，由调用方转成 404', () => {
    expect(parseStratzPayload({ data: { player: null } })).toBeNull();
  });

  it('GraphQL 校验/字段错误必须原样抛出，不能静默降级', () => {
    const payload = {
      errors: [{ message: 'Cannot query field "rankzz" on type "Player".' }],
    };
    expect(() => parseStratzPayload(payload)).toThrowError(ApiError);
    expect(() => parseStratzPayload(payload)).toThrowError(/Cannot query field/);
  });

  it('非 JSON 对象（网关错误页之类）也抛 ApiError', () => {
    for (const bad of [null, undefined, 'oops', 42]) {
      expect(() => parseStratzPayload(bad)).toThrowError(ApiError);
    }
  });
});

/* ==========================================================================
 * 请求契约：不打真接口，用假 fetch 钉住 URL / 鉴权头 / 变量。
 * 真 token 只有部署环境才有，这里保证"配了 token 就一定打 STRATZ、
 * 失败了也不会偷偷回退去烧 OpenDota 的额度"这两条不会被改坏。
 * ========================================================================== */

const OK_BODY = {
  data: { player: { steamAccount: { id: 1, name: 'ChatGPT', avatar: null }, ranks: [{ rank: 53 }] } },
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Call = { url: string; init: RequestInit };

function stubFetch(handler: (url: string) => Response) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return handler(url);
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const envWithToken = { STRATZ_API_TOKEN: 'test-token' } as unknown as Env;
const envWithoutToken = {} as unknown as Env;

describe('段位抓取入口', () => {
  it('配了 token 就打 STRATZ，带 Bearer、变量是数字 ID', async () => {
    const stub = stubFetch(() => json(OK_BODY));
    try {
      const snapshot = await fetchRankSnapshot(envWithToken, 699433735);
      expect(stub.calls).toHaveLength(1);
      expect(stub.calls[0]?.url).toBe('https://api.stratz.com/graphql');
      const headers = stub.calls[0]?.init.headers as Record<string, string>;
      expect(headers.authorization).toBe('Bearer test-token');
      expect(headers['user-agent']).toBeTruthy();
      expect(JSON.parse(String(stub.calls[0]?.init.body)).variables.steamAccountId).toBe(699433735);
      expect(snapshot).toMatchObject({ source: 'STRATZ', rankTier: 53, personaName: 'ChatGPT' });
    } finally {
      stub.restore();
    }
  });

  it('token 无效时直接报错，不回退去烧 OpenDota 的额度', async () => {
    const stub = stubFetch(() => json({ error: 'unauthorized' }, 403));
    try {
      await expect(fetchRankSnapshot(envWithToken, 1)).rejects.toThrowError(/token/);
      expect(stub.calls).toHaveLength(1);
      expect(stub.calls.some((call) => call.url.includes('opendota'))).toBe(false);
    } finally {
      stub.restore();
    }
  });

  it('429 抛 RATE_LIMITED，交给上层给"稍后再试"的文案', async () => {
    const stub = stubFetch(() => json({ error: 'too many' }, 429));
    try {
      await expect(fetchRankSnapshot(envWithToken, 1)).rejects.toMatchObject({
        code: 'RATE_LIMITED',
      });
    } finally {
      stub.restore();
    }
  });

  it('STRATZ 查无此人 → NOT_FOUND', async () => {
    const stub = stubFetch(() => json({ data: { player: null } }));
    try {
      await expect(fetchRankSnapshot(envWithToken, 1)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    } finally {
      stub.restore();
    }
  });

  /**
   * STRATZ 的覆盖不如 OpenDota 全：实测同一账号 OpenDota 有 rank_tier=64，
   * STRATZ 的 ranks 是空数组。这种情况下要补一次 OpenDota，否则这些人永远同步不到段位。
   */
  it('STRATZ 答了但没段位 → 用 OpenDota 补一次，来源标 OPENDOTA', async () => {
    const stub = stubFetch((url) => {
      if (url.includes('stratz')) {
        return json({ data: { player: { steamAccount: { id: 1, name: 'Night King', avatar: null }, ranks: [] } } });
      }
      if (url.endsWith('/wl')) return json({ win: 10, lose: 5 });
      return json({ profile: { personaname: 'Night King', avatarfull: null }, rank_tier: 64 });
    });
    try {
      const snapshot = await fetchRankSnapshot(envWithToken, 218675066);
      expect(snapshot).toMatchObject({ source: 'OPENDOTA', rankTier: 64, careerMatches: 15 });
      expect(stub.calls.some((call) => call.url.includes('opendota'))).toBe(true);
    } finally {
      stub.restore();
    }
  });

  it('STRATZ 与 OpenDota 都没段位 → 保留 STRATZ 的结果，不报错', async () => {
    const stub = stubFetch((url) => {
      if (url.includes('stratz')) {
        return json({ data: { player: { steamAccount: { id: 1, name: 'X', avatar: null }, ranks: [] } } });
      }
      return json({ profile: { personaname: 'X', avatarfull: null }, rank_tier: null });
    });
    try {
      const snapshot = await fetchRankSnapshot(envWithToken, 1);
      expect(snapshot).toMatchObject({ source: 'STRATZ', rankTier: null });
    } finally {
      stub.restore();
    }
  });

  it('补位时 OpenDota 挂了也不影响：仍然返回 STRATZ 的结果', async () => {
    const stub = stubFetch((url) => {
      if (url.includes('stratz')) {
        return json({ data: { player: { steamAccount: { id: 1, name: 'X', avatar: null }, ranks: [] } } });
      }
      return json({ error: 'boom' }, 500);
    });
    try {
      const snapshot = await fetchRankSnapshot(envWithToken, 1);
      expect(snapshot).toMatchObject({ source: 'STRATZ', rankTier: null });
    } finally {
      stub.restore();
    }
  });

  it('没配 token 时退回 OpenDota（来源标 OPENDOTA）', async () => {
    const stub = stubFetch((url) => {
      if (url.endsWith('/wl')) return json({ win: 10, lose: 5 });
      return json({ profile: { personaname: 'x', avatarfull: null }, rank_tier: 45 });
    });
    try {
      const snapshot = await fetchRankSnapshot(envWithoutToken, 109902856);
      expect(snapshot).toMatchObject({
        source: 'OPENDOTA',
        rankTier: 45,
        careerMatches: 15,
      });
      expect(stub.calls.every((call) => call.url.includes('opendota'))).toBe(true);
    } finally {
      stub.restore();
    }
  });
});
