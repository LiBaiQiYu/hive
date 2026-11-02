/**
 * PLAYER_SYNC 的写回契约。
 *
 * 昵称/头像原来只在"绑定那一刻"写一次，之后没有任何地方刷新——绑定时上游抽风，
 * 或者当时还没配 STEAM_WEB_API_KEY，这个账号就永远停在"有段位、没头像"。
 * 这里钉住三件事：
 *   1. 快照里有昵称/头像时，同步要写回 game_accounts；
 *   2. 用 COALESCE：只填空，绝不拿 null 覆盖已有值；
 *   3. 快照里两样都没有时，压根不碰这一行（省一次写）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../env';
import { handleJob } from './handlers';

vi.mock('../services/rating', () => ({ recomputeUserRating: vi.fn(async () => undefined) }));

const AVATAR = 'https://avatars.steamstatic.com/abc_full.jpg';

type Call = { sql: string; binds: unknown[] };

/**
 * 只认 handlers.ts 真正会发的那几条语句，其余一律返回空。
 * 不追求通用 SQL 引擎——单测要的是"发了什么语句、绑了什么值"。
 */
function fakeDb(options: { statsExists?: boolean } = {}) {
  const calls: Call[] = [];
  const { statsExists = true } = options;

  const db = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          calls.push({ sql, binds });
          return {
            first: async () => {
              if (sql.includes('dota_account_id')) return { dotaAccountId: 699433735 };
              if (sql.includes('FROM player_stats')) return statsExists ? { id: 'ps_1' } : null;
              return null;
            },
            run: async () => ({ meta: { changes: 1 } }),
            all: async () => ({ results: [] }),
          };
        },
      };
    },
  };

  return { env: { DB: db } as unknown as Env, calls };
}

/** 假 STRATZ 响应：只带昵称/头像、没段位（这样不会触发 OpenDota 兜底） */
function stubStratz(body: unknown) {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

const stratzPlayer = (steamAccount: { name: string | null; avatar: string | null }, rank: number) => ({
  data: { player: { steamAccount: { id: 1, ...steamAccount }, ranks: rank ? [{ rank }] : [] } },
});

describe('PLAYER_SYNC 把昵称/头像写回 game_accounts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('快照带昵称与头像时写回，并用 COALESCE 防止 null 覆盖', async () => {
    const { env, calls } = fakeDb();
    (env as { STRATZ_API_TOKEN?: string }).STRATZ_API_TOKEN = 'test-token';
    const restore = stubStratz(stratzPlayer({ name: 'ChatGPT', avatar: AVATAR }, 53));
    try {
      await handleJob(env, 'PLAYER_SYNC', JSON.stringify({ userId: 'u1' }));
    } finally {
      restore();
    }

    const writeBack = calls.find((call) => /UPDATE\s+game_accounts/i.test(call.sql));
    expect(writeBack, '应该有一条写回 game_accounts 的 UPDATE').toBeTruthy();
    expect(writeBack?.sql).toMatch(/persona_name\s*=\s*COALESCE\(\?/i);
    expect(writeBack?.sql).toMatch(/avatar_url\s*=\s*COALESCE\(\?/i);
    // binds: [personaName, avatarUrl, lastSyncedAt, updatedAt, userId]
    expect(writeBack?.binds.slice(0, 2)).toEqual(['ChatGPT', AVATAR]);
    expect(writeBack?.binds[4]).toBe('u1');
  });

  it('只有段位、没有昵称头像时不动 game_accounts', async () => {
    const { env, calls } = fakeDb();
    (env as { STRATZ_API_TOKEN?: string }).STRATZ_API_TOKEN = 'test-token';
    const restore = stubStratz(stratzPlayer({ name: null, avatar: null }, 53));
    try {
      await handleJob(env, 'PLAYER_SYNC', JSON.stringify({ userId: 'u1' }));
    } finally {
      restore();
    }

    expect(calls.some((call) => /UPDATE\s+game_accounts/i.test(call.sql))).toBe(false);
    // 段位本身还是要写的
    expect(calls.some((call) => /UPDATE\s+player_stats/i.test(call.sql))).toBe(true);
  });

  it('还没建 player_stats 行时走 INSERT，头像照样写回', async () => {
    const { env, calls } = fakeDb({ statsExists: false });
    (env as { STRATZ_API_TOKEN?: string }).STRATZ_API_TOKEN = 'test-token';
    const restore = stubStratz(stratzPlayer({ name: 'ChatGPT', avatar: AVATAR }, 53));
    try {
      await handleJob(env, 'PLAYER_SYNC', JSON.stringify({ userId: 'u1' }));
    } finally {
      restore();
    }

    expect(calls.some((call) => /INSERT INTO player_stats/i.test(call.sql))).toBe(true);
    expect(calls.some((call) => /UPDATE\s+game_accounts/i.test(call.sql))).toBe(true);
  });
});
