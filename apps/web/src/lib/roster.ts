/**
 * 赛事报名名单（列表视图）的排序。
 *
 * 和排行榜共用 `sortPlayers` 的比较规则（null 沉底、同值按 WARROOM 再按 id），
 * 但多一条硬约束：**排序只在正选、候补各自内部生效**。
 * 否则按段位排序时，一个高段位的候补会跑到正选前面，读者会以为他已经进局了。
 */
import { sortPlayers, type PlayerListRow } from './player-table';
import type { SortState } from './sort';

/** 名单里可排序的三列：段位 / 天梯 MMR / WARROOM */
export type RosterSortKey = 'rankTier' | 'mmr' | 'effective';

export interface RosterSortable extends PlayerListRow {
  /** 报名状态：CONFIRMED / WAITLIST */
  status: string;
}

/**
 * @param sort null 表示不排序——保持服务端给的「正选按评分 → 候补按报名顺序」
 */
export function sortRosterRows<T extends RosterSortable>(
  rows: readonly T[],
  sort: SortState<RosterSortKey> | null,
): T[] {
  if (!sort) return [...rows];
  const confirmed = rows.filter((row) => row.status !== 'WAITLIST');
  const waitlist = rows.filter((row) => row.status === 'WAITLIST');
  return [...sortPlayers(confirmed, sort), ...sortPlayers(waitlist, sort)];
}
