/**
 * 段位抓取：STRATZ 优先，OpenDota 兜底。
 *
 * 为什么换 STRATZ：OpenDota 的免费额度是**按 IP** 计的（实测 60/分、约 3000/天，
 * 响应头 X-Rate-Limit-* 会逐次递减），而 Worker 是从 Cloudflare 的共享出口 IP
 * 发请求的——额度和别人共用，会出现"我们没怎么用却 429"。STRATZ 用 Bearer token，
 * 额度跟着 token 走，可控得多。
 *
 * 没配 STRATZ_API_TOKEN 时自动退回 OpenDota，保证功能不中断；响应里会写明来源，
 * 不做"看起来一样其实换了个源"的静默降级。
 */
import { ApiError } from '@hive/shared';
import type { Env } from '../env';

export type RankSource = 'STRATZ' | 'OPENDOTA';

export interface RankSnapshot {
  source: RankSource;
  /** 游戏昵称（Steam persona） */
  personaName: string | null;
  avatarUrl: string | null;
  /** 段位编码：十位勋章 + 个位星级；null = 没公开数据 */
  rankTier: number | null;
  /**
   * 累计场次：只有 OpenDota 的 /wl 会给。
   * STRATZ 这条路径不单独为它多打一次请求——它只影响置信度，宁缺毋滥。
   */
  careerMatches: number | null;
}

/* ==========================================================================
 * STRATZ
 * ========================================================================== */

const STRATZ_ENDPOINT = 'https://api.stratz.com/graphql';

/**
 * 只取三段信息：昵称、头像、段位。
 * rank 的编码与 Dota 的 rank_tier 一致（十位勋章 + 个位星级），
 * 所以拿到之后不需要换算。
 *
 * 注意字段名是 **ranks**（复数）：STRATZ 返回的是"按赛季排列的段位列表"，
 * 最前面一条是当前赛季（实测与 OpenDota 的 rank_tier 一致），
 * 历史上写 `rank { rank }` 会直接报 "Cannot query field 'rank'"。
 * 这个类型上没有 season 字段可用，所以只能依赖它的倒序约定。
 */
const STRATZ_QUERY = `query PlayerRank($steamAccountId: Long!) {
  player(steamAccountId: $steamAccountId) {
    steamAccount { id name avatar }
    ranks { rank }
  }
}`;

interface StratzPlayer {
  steamAccount?: { id?: number; name?: string | null; avatar?: string | null } | null;
  /** 按赛季倒序：第一条是当前赛季 */
  ranks?: Array<{ rank?: number | null }> | null;
}

interface StratzPayload {
  data?: { player?: StratzPlayer | null } | null;
  errors?: Array<{ message?: string }> | null;
}

/**
 * 纯解析（可单测）：把 GraphQL 响应拆成昵称/头像/段位。
 * 返回 null 表示"查无此人"；GraphQL 报了字段级错误则直接抛，不做静默兜底。
 */
export function parseStratzPayload(payload: unknown): {
  personaName: string | null;
  avatarUrl: string | null;
  rankTier: number | null;
} | null {
  if (!payload || typeof payload !== 'object') {
    throw new ApiError('CONFLICT', 'STRATZ 返回的不是预期的 GraphQL 结构');
  }
  const body = payload as StratzPayload;
  const player = body.data?.player ?? null;

  // 校验阶段的错误（字段名写错等）没有 data，必须原样报出来，否则永远查不到原因
  if (!player && Array.isArray(body.errors) && body.errors.length > 0) {
    const message = body.errors[0]?.message ?? '未知错误';
    throw new ApiError('CONFLICT', `STRATZ 查询失败：${message}`);
  }
  if (!player) return null;

  const rank = player.ranks?.[0]?.rank;
  return {
    personaName: player.steamAccount?.name ?? null,
    avatarUrl: player.steamAccount?.avatar ?? null,
    // 只接受合法编码（11..85）；0 / null / 空列表一律当"没公开"
    rankTier: typeof rank === 'number' && rank >= 11 && rank <= 85 ? rank : null,
  };
}

async function fetchFromStratz(token: string, accountId: number): Promise<RankSnapshot> {
  let response: Response;
  try {
    response = await fetch(STRATZ_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        // STRATZ 文档明确要求带 User-Agent，缺了会被直接拒
        'user-agent': 'HIVE/1.0',
      },
      body: JSON.stringify({ query: STRATZ_QUERY, variables: { steamAccountId: accountId } }),
    });
  } catch {
    throw new ApiError('CONFLICT', '无法连接 STRATZ，请检查网络或稍后再试');
  }

  if (response.status === 401 || response.status === 403) {
    throw new ApiError('CONFLICT', 'STRATZ token 无效或已过期，请联系管理员更新');
  }
  if (response.status === 429) {
    throw new ApiError('RATE_LIMITED', 'STRATZ 限流了，请稍后再试');
  }
  if (!response.ok) {
    throw new ApiError('CONFLICT', `STRATZ 返回 ${response.status}，稍后再试`);
  }

  const parsed = parseStratzPayload(await response.json().catch(() => null));
  if (!parsed) throw new ApiError('NOT_FOUND', 'STRATZ 里没有这个账号的资料');

  return { source: 'STRATZ', careerMatches: null, ...parsed };
}

/* ==========================================================================
 * OpenDota（兜底）
 * ========================================================================== */

interface OpenDotaPlayer {
  profile?: { personaname?: string; avatarfull?: string };
  rank_tier?: number | null;
}

async function fetchFromOpenDota(accountId: number): Promise<RankSnapshot> {
  let player: OpenDotaPlayer;
  try {
    const response = await fetch(`https://api.opendota.com/api/players/${accountId}`);
    if (response.status === 404) {
      throw new ApiError('NOT_FOUND', '查不到这个账号，请确认数字 ID 是否正确');
    }
    if (response.status === 429) {
      throw new ApiError('RATE_LIMITED', 'OpenDota 限流了，请稍后再试');
    }
    if (!response.ok) {
      throw new ApiError('CONFLICT', `OpenDota 返回 ${response.status}，稍后再试`);
    }
    player = (await response.json()) as OpenDotaPlayer;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError('CONFLICT', '无法连接 OpenDota，请检查网络或稍后再试');
  }

  if (!player.profile) throw new ApiError('NOT_FOUND', 'OpenDota 里没有这个账号的资料');

  // 累计场次只影响置信度：拿不到就算了，不为了它把整个流程判失败
  let careerMatches: number | null = null;
  try {
    const wl = await fetch(`https://api.opendota.com/api/players/${accountId}/wl`);
    if (wl.ok) {
      const data = (await wl.json()) as { win?: number; lose?: number };
      careerMatches = (data.win ?? 0) + (data.lose ?? 0);
    }
  } catch {
    /* 忽略 */
  }

  return {
    source: 'OPENDOTA',
    personaName: player.profile.personaname ?? null,
    avatarUrl: player.profile.avatarfull ?? null,
    rankTier: typeof player.rank_tier === 'number' ? player.rank_tier : null,
    careerMatches,
  };
}

/* ==========================================================================
 * 对外入口
 * ========================================================================== */

/** 配了 token 就走 STRATZ，否则退回 OpenDota */
export async function fetchRankSnapshot(env: Env, accountId: number): Promise<RankSnapshot> {
  if (env.STRATZ_API_TOKEN) return fetchFromStratz(env.STRATZ_API_TOKEN, accountId);
  return fetchFromOpenDota(accountId);
}
