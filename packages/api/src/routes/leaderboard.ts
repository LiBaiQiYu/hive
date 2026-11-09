/**
 * 排行榜（公开）。
 *
 * 排序维度只有两个是"现在就有数据"的：
 *   · rating —— player_ratings.effective_rating
 *   · wins   —— 已结束比赛里赢的场次（由 team_members + matches.radiant_win 现算）
 *
 * MVP 需要 match_player_stats，而那张表还没有数据（对局导入没做），
 * 所以这里不提供 mvp 排序——宁可不给，也不返回一列恒为 0 的假数据。
 *
 * 段位 / 天梯分是**只读展示**，不参与排序：它们是评分的输入，不是结果，
 * 拿它排序会让"分数高但没填 MMR"的人莫名其妙掉到后面。
 */
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { noShowCountMap } from '../services/attendance';

export const leaderboardRoutes = new Hono<AppEnv>();

const SORTS = ['rating', 'wins'] as const;
type SortKey = (typeof SORTS)[number];

interface Row {
  id: string;
  username: string;
  displayName: string;
  role: string;
  effective: number;
  system: number;
  adjustment: number;
  confidenceBp: number;
  wins: number;
  losses: number;
  played: number;
  /** 天梯段位编码（十位勋章 + 个位星级）；没同步过就是 null */
  rankTier: number | null;
  /** 天梯分：只有「自报」路线才有值，Steam / OpenDota / STRATZ 同步不带 MMR */
  declaredMmr: number | null;
  rankSource: string | null;
  /** 身份验证等级：VERIFIED（Steam）/ CLAIMED（数字 ID）/ null（自报） */
  verification: string | null;
}

leaderboardRoutes.get('/', async (c) => {
  const raw = c.req.query('sort');
  const sort: SortKey = (SORTS as readonly string[]).includes(raw ?? '') ? (raw as SortKey) : 'rating';
  const limitRaw = Number.parseInt(c.req.query('limit') ?? '', 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 50;

  // 战绩口径：正选出场 + 比赛已结束且有胜负。候补/流局都不计入。
  // 段位与天梯分来自 player_stats（LEFT JOIN：没同步过的玩家照样上榜，值是 null）
  const rows = await c.env.DB.prepare(
    `SELECT u.id, u.username, u.display_name AS displayName, u.role,
            COALESCE(pr.effective_rating, 500) AS effective,
            COALESCE(pr.system_rating, 500) AS system,
            COALESCE(pr.admin_adjustment, 0) AS adjustment,
            COALESCE(pr.confidence_bp, 0) AS confidenceBp,
            ps.rank_tier AS rankTier,
            ps.declared_mmr AS declaredMmr,
            ps.rank_source AS rankSource,
            ga.verification AS verification,
            COALESCE(w.wins, 0) AS wins,
            COALESCE(w.losses, 0) AS losses,
            COALESCE(w.played, 0) AS played
       FROM users u
       LEFT JOIN player_ratings pr ON pr.user_id = u.id
       LEFT JOIN player_stats ps ON ps.user_id = u.id
       LEFT JOIN game_accounts ga ON ga.user_id = u.id
       LEFT JOIN (
         SELECT tm.user_id AS userId,
                SUM(CASE WHEN (tm.team_side = 'RADIANT' AND m.radiant_win = 1)
                           OR (tm.team_side = 'DIRE' AND m.radiant_win = 0)
                         THEN 1 ELSE 0 END) AS wins,
                SUM(CASE WHEN (tm.team_side = 'RADIANT' AND m.radiant_win = 0)
                           OR (tm.team_side = 'DIRE' AND m.radiant_win = 1)
                         THEN 1 ELSE 0 END) AS losses,
                COUNT(*) AS played
           FROM team_members tm
           JOIN matches m ON m.id = tm.match_id
          WHERE tm.is_substitute = 0 AND m.status = 'COMPLETED' AND m.radiant_win IS NOT NULL
          GROUP BY tm.user_id
       ) w ON w.userId = u.id
      WHERE u.status = 'ACTIVE'
      ORDER BY ${sort === 'wins' ? 'wins DESC, effective DESC' : 'effective DESC, wins DESC'}, u.username ASC
      LIMIT ?`,
  )
    .bind(limit)
    .all<Row>();

  const noShows = await noShowCountMap(c.env);

  const entries = (rows.results ?? []).map((row, index) => ({
    rank: index + 1,
    ...row,
    // 弃赛：报名了、进了正选，但比赛时没来、被替补顶下来的场次。
    // 它不进入胜负统计（那场他没打），只影响出勤率与这里的展示。
    noShows: noShows.get(row.id) ?? 0,
    // 胜率用基点，和项目里其它比率字段保持一致
    winRateBp: row.played > 0 ? Math.round((row.wins / row.played) * 10000) : null,
  }));

  return c.json({
    data: { sort, limit, entries },
    meta: { requestId: c.get('requestId') },
  });
});
