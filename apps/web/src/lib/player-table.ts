/**
 * 玩家列表的筛选与排序：排行榜、战绩页「全员胜场」、后台成员列表共用。
 *
 * 三张表的数据形状差不多，但以前各写各的排序；把规则收到这里之后，
 * 「同一批人，两页顺序不一样」这种问题不会再出现，也能被单测钉住。
 */
import { compareNullable, type SortState } from './sort';
import { verificationOf, type VerificationFilter } from './verification';

/** 三个列表共有的字段（战绩页/排行榜有胜负，后台成员表没有） */
export interface PlayerListRow {
  id: string;
  /** game_accounts.verification：VERIFIED / CLAIMED / null */
  verification: string | null;
  /** WARROOM 评分 */
  effective: number;
  rankTier: number | null;
  declaredMmr: number | null;
  rankSource?: string | null;
  wins?: number;
  winRateBp?: number | null;
}

export type PlayerSortKey = 'effective' | 'rankTier' | 'mmr' | 'wins' | 'winRate';

/** 取排序值；没有的字段一律 null（由 compareNullable 沉底） */
export function sortValue(row: PlayerListRow, key: PlayerSortKey): number | null {
  switch (key) {
    case 'effective':
      return row.effective;
    case 'rankTier':
      return row.rankTier;
    case 'mmr':
      return row.declaredMmr;
    case 'wins':
      return row.wins ?? null;
    case 'winRate':
      return row.winRateBp ?? null;
  }
}

/**
 * 排序：主键由用户点选，同值再按 WARROOM、最后按 id。
 * 后两级保证"同一批数据每次排出同样的顺序"，翻页/刷新时不会莫名其妙换位。
 */
export function sortPlayers<T extends PlayerListRow>(
  rows: readonly T[],
  sort: SortState<PlayerSortKey>,
): T[] {
  return [...rows].sort((a, b) => {
    const primary = compareNullable(sortValue(a, sort.key), sortValue(b, sort.key), sort.direction);
    if (primary !== 0) return primary;
    const secondary = compareNullable(a.effective, b.effective, 'desc');
    if (secondary !== 0) return secondary;
    return a.id.localeCompare(b.id);
  });
}

export function filterPlayers<T extends PlayerListRow>(
  rows: readonly T[],
  filter: VerificationFilter,
): T[] {
  if (filter === 'ALL') return [...rows];
  return rows.filter((row) => verificationOf(row.verification) === filter);
}

/** 筛选项上的计数：让人知道点下去还剩几个，而不是点完发现是空的 */
export function verificationCounts<T extends { verification: string | null }>(
  rows: readonly T[],
): Record<VerificationFilter, number> {
  const counts: Record<VerificationFilter, number> = {
    ALL: rows.length,
    VERIFIED: 0,
    CLAIMED: 0,
    SELF_REPORTED: 0,
  };
  for (const row of rows) counts[verificationOf(row.verification)] += 1;
  return counts;
}
