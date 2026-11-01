import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { ApiError, newId } from '@hive/shared';
import type { AppEnv } from '../env';
import { requireAdmin, requireUser } from '../guard';
import {
  STEAM_STATE_COOKIE,
  STATE_TTL_SECONDS,
  buildAuthUrl,
  fetchPersona,
  probeSteamKey,
  resolveOrigin,
  signState,
  toDotaAccountId,
  verifyCallback,
  verifyState,
} from '../steam';

export const steamRoutes = new Hono<AppEnv>();

const STATE_PATH = '/api/auth/steam';

/** 浏览器跳转流程用重定向报错，避免把 JSON 甩到用户脸上 */
function backToMe(origin: string, params: Record<string, string>): Response {
  const query = new URLSearchParams(params).toString();
  return new Response(null, {
    status: 302,
    headers: { location: `${origin}/me?${query}` },
  });
}

/* -------------------------------------------------------------------------- */
steamRoutes.get('/start', async (c) => {
  requireUser(c);
  const resolved = resolveOrigin(c.env.APP_ORIGIN, c.req.url);

  // 兜底：如果最终 origin 仍是占位域名，宁可报错也不要用户被扔进黑洞域名
  if (/(^|\.)(example\.(com|org|net))$/i.test(new URL(resolved.origin).hostname)) {
    throw new ApiError(
      'CONFLICT',
      '部署地址仍是占位域名（hive.example.com）。请用 http://127.0.0.1:8787 访问，或把 wrangler.jsonc 里的 APP_ORIGIN 改成真实域名',
    );
  }

  const state = await signState(c.env.PASSWORD_PEPPER);

  setCookie(c, STEAM_STATE_COOKIE, state, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: STATE_PATH,
    maxAge: STATE_TTL_SECONDS,
  });

  c.header('x-hive-steam-origin', resolved.origin);
  return c.redirect(buildAuthUrl(resolved.origin, state));
});

/** 自查用：把服务端实际会用的 origin / return_to 打出来，排查回调地址问题 */
steamRoutes.get('/diagnose', async (c) => {
  requireUser(c);
  const resolved = resolveOrigin(c.env.APP_ORIGIN, c.req.url);

  return c.json({
    data: {
      appOrigin: c.env.APP_ORIGIN ?? null,
      requestOrigin: new URL(c.req.url).origin,
      effectiveOrigin: resolved.origin,
      source: resolved.source,
      warning: resolved.warning ?? null,
      returnTo: `${resolved.origin}/api/auth/steam/callback`,
      hint: '如果 effectiveOrigin 不是你浏览器里打开的地址，Steam 回调就会跳到别处',
    },
  });
});

/* -------------------------------------------------------------------------- */
/**
 * 自查用（管理员）：拿当前配置的 key 真请求一次 Steam，回答「配没配 / 有没有效」。
 * 默认探测自己绑定的 Steam ID，也可以传 ?steamId=7656...
 */
steamRoutes.get('/probe', async (c) => {
  const userId = requireAdmin(c);
  const bound = await c.env.DB.prepare(
    `SELECT steam_id64 AS steamId64 FROM game_accounts WHERE user_id = ?`,
  )
    .bind(userId)
    .first<{ steamId64: string | null }>();

  const steamId = c.req.query('steamId') ?? bound?.steamId64 ?? null;
  if (!steamId) {
    throw new ApiError('VALIDATION_FAILED', '没有可探测的 Steam ID，请传 ?steamId=7656119...');
  }

  const probe = await probeSteamKey(c.env.STEAM_WEB_API_KEY, steamId);
  return c.json({ data: { steamId, ...probe } });
});

/* -------------------------------------------------------------------------- */
steamRoutes.get('/callback', async (c) => {
  const userId = requireUser(c);
  const env = c.env;
  const url = new URL(c.req.url);
  const origin = url.origin;

  const cookieState = getCookie(c, STEAM_STATE_COOKIE);
  deleteCookie(c, STEAM_STATE_COOKIE, { path: STATE_PATH });

  // 校验点 1：state 必须与发起时的 Cookie 一致（防 CSRF / 账号劫持）
  const queryState = url.searchParams.get('state');
  if (!cookieState || !queryState || cookieState !== queryState) {
    return backToMe(origin, { steam: 'error', reason: 'state' });
  }
  if (!(await verifyState(env.PASSWORD_PEPPER, cookieState))) {
    return backToMe(origin, { steam: 'error', reason: 'state' });
  }

  // 校验点 2~6 都在 verifyCallback 里：op_endpoint / return_to / claimed_id / 反向 POST
  const verified = await verifyCallback({ origin, params: url.searchParams });
  if (!verified.ok || !verified.steamId64) {
    return backToMe(origin, { steam: 'error', reason: 'verify' });
  }

  const steamId64 = verified.steamId64;
  const dotaAccountId = toDotaAccountId(steamId64);
  const persona = await fetchPersona(env.STEAM_WEB_API_KEY, steamId64);
  const now = Date.now();

  // 一个 DOTA 账号只能绑一个 HIVE 账号
  const taken = await env.DB.prepare(
    `SELECT user_id AS userId FROM game_accounts WHERE dota_account_id = ?`,
  )
    .bind(dotaAccountId)
    .first<{ userId: string }>();
  if (taken && taken.userId !== userId) {
    return backToMe(origin, { steam: 'error', reason: 'taken' });
  }

  // 一人一号：已有绑定就升级成 OpenID，不新增行
  const existing = await env.DB.prepare(`SELECT id FROM game_accounts WHERE user_id = ?`)
    .bind(userId)
    .first<{ id: string }>();

  if (existing) {
    await env.DB.prepare(
      `UPDATE game_accounts
          SET provider = 'STEAM_OPENID', steam_id64 = ?, dota_account_id = ?, verification = 'VERIFIED',
              persona_name = COALESCE(?, persona_name), avatar_url = COALESCE(?, avatar_url),
              verified_at = ?, updated_at = ?
        WHERE id = ?`,
    )
      .bind(steamId64, dotaAccountId, persona?.personaName ?? null, persona?.avatarUrl ?? null, now, now, existing.id)
      .run();
  } else {
    await env.DB.prepare(
      `INSERT INTO game_accounts (id, user_id, provider, steam_id64, dota_account_id, verification,
         persona_name, avatar_url, profile_url, is_primary, verified_at, created_at, updated_at)
       VALUES (?, ?, 'STEAM_OPENID', ?, ?, 'VERIFIED', ?, ?, ?, 1, ?, ?, ?)`,
    )
      .bind(
        newId(now),
        userId,
        steamId64,
        dotaAccountId,
        persona?.personaName ?? null,
        persona?.avatarUrl ?? null,
        `https://steamcommunity.com/profiles/${steamId64}`,
        now,
        now,
        now,
      )
      .run();
  }

  // 刚绑上 Steam，手里有了 dota_account_id：排一条 PLAYER_SYNC 去拉段位与累计场次，
  // 拉到之后 handler 会顺手重算评分。幂等：同一玩家只会有一条在途任务。
  const dedupeKey = `player:${userId}`;
  await env.DB.prepare(
    `INSERT OR IGNORE INTO sync_jobs (id, kind, payload_json, dedupe_key, status, available_at, created_at, updated_at)
     VALUES (?, 'PLAYER_SYNC', ?, ?, 'PENDING', ?, ?, ?)`,
  )
    .bind(newId(now), JSON.stringify({ userId }), dedupeKey, now, now, now)
    .run();

  await env.DB.prepare(
    `INSERT INTO audit_logs (id, actor_id, actor_role, action, entity_type, entity_id, after_json, created_at)
     VALUES (?, ?, 'PLAYER', 'steam.link', 'user', ?, ?, ?)`,
  )
    .bind(newId(now), userId, userId, JSON.stringify({ dotaAccountId }), now)
    .run();

  return backToMe(origin, { steam: 'linked' });
});

/* -------------------------------------------------------------------------- */
steamRoutes.delete('/unlink', async (c) => {
  const userId = requireUser(c);

  const linked = await c.env.DB.prepare(`SELECT id FROM game_accounts WHERE user_id = ?`)
    .bind(userId)
    .first<{ id: string }>();
  if (!linked) throw new ApiError('NOT_FOUND', '还没有绑定 Steam');

  await c.env.DB.prepare(`DELETE FROM game_accounts WHERE user_id = ?`).bind(userId).run();

  return c.json({ data: { ok: true } });
});
