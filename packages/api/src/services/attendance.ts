/**
 * 出勤与弃赛统计。
 *
 * 弃赛的定义只有一种：**进了正选名单、比赛时人没到，被换了下去**
 * （`match_substitutions.reason = 'ABSENT'`，且那一场已经打完）。
 *
 * 为什么不在 `player_ratings` 里存一个计数：换人那一刻 team_members 里那一行就被删掉、
 * 换成了替补，所以"实际出场"天然不含他——出勤率已经自动变低。这里只是把同一批事实
 * 单独数出来给页面显示（排行榜、战绩、个人主页），不改变评分口径，也不用担心计数漂移。
 */
import type { Env } from '../env';

export interface NoShowRow {
  matchId: string;
  matchNo: number;
  eventId: string;
  eventTitle: string;
  /** 被换下时的时间（就是换人操作时间） */
  at: number;
  position: number;
  side: 'RADIANT' | 'DIRE';
}

/** 弃赛的公共筛选条件：被人换下的那笔记录 + 那场比赛确实打完了 */
const NO_SHOW_FROM = `
  FROM match_substitutions ms
  JOIN matches m ON m.id = ms.match_id
 WHERE ms.reason = 'ABSENT' AND ms.out_user_id IS NOT NULL AND m.status = 'COMPLETED'
`;

/** 一次算出所有人的弃赛次数（排行榜用，避免 N+1） */
export async function noShowCountMap(env: Env): Promise<Map<string, number>> {
  const rows = await env.DB.prepare(
    `SELECT ms.out_user_id AS userId, count(*) AS noShows ${NO_SHOW_FROM} GROUP BY ms.out_user_id`,
  ).all<{ userId: string; noShows: number }>();

  const map = new Map<string, number>();
  for (const row of rows.results ?? []) map.set(row.userId, row.noShows);
  return map;
}

export async function countNoShows(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT count(*) AS noShows ${NO_SHOW_FROM} AND ms.out_user_id = ?`,
  )
    .bind(userId)
    .first<{ noShows: number }>();
  return row?.noShows ?? 0;
}

/** 某人的弃赛明细（个人主页 / 战绩页用），最近的在前 */
export async function listNoShows(env: Env, userId: string, limit = 20): Promise<NoShowRow[]> {
  const rows = await env.DB.prepare(
    `SELECT ms.match_id AS matchId, ms.assigned_position AS position, ms.team_side AS side,
            ms.created_at AS at, m.match_no AS matchNo,
            e.id AS eventId, e.title AS eventTitle
       FROM match_substitutions ms
       JOIN matches m ON m.id = ms.match_id
       JOIN events e ON e.id = m.event_id
      WHERE ms.reason = 'ABSENT' AND ms.out_user_id = ? AND m.status = 'COMPLETED'
      ORDER BY ms.created_at DESC
      LIMIT ?`,
  )
    .bind(userId, Math.min(Math.max(limit, 1), 50))
    .all<NoShowRow>();
  return rows.results ?? [];
}

/**
 * 在 `collectInput` 的出勤口径上补一句说明用：
 * 报名过、赛事结束、但没上场（含被临时顶替）都算"未出场"。
 */
export const ATTENDANCE_NOTE =
  '出勤率 = 已结束赛事里实际出场的场次 ÷ 报名的场次；报名后没到场、被替补顶下来都算未出场';
