/**
 * 玩家列表的筛选 / 排序规则。
 *
 * 这些函数在三个页面共用，所以把边界情况钉在这里：空值沉底、
 * 同值有稳定次序、筛选计数和筛选结果必须一致。
 */
import { describe, expect, it } from 'vitest';
import { compareNullable, nextSort } from './sort';
import {
  filterPlayers,
  sortPlayers,
  verificationCounts,
  type PlayerListRow,
} from './player-table';

const row = (id: string, patch: Partial<PlayerListRow> = {}): PlayerListRow => ({
  id,
  verification: null,
  effective: 500,
  rankTier: null,
  declaredMmr: null,
  ...patch,
});

describe('compareNullable', () => {
  it('null 永远沉底，升降序都一样', () => {
    expect(compareNullable(null, 5, 'asc')).toBeGreaterThan(0);
    expect(compareNullable(null, 5, 'desc')).toBeGreaterThan(0);
    expect(compareNullable(5, null, 'asc')).toBeLessThan(0);
    expect(compareNullable(null, null, 'asc')).toBe(0);
  });

  it('正常值按方向比较', () => {
    expect(compareNullable(1, 2, 'asc')).toBeLessThan(0);
    expect(compareNullable(1, 2, 'desc')).toBeGreaterThan(0);
  });
});

describe('nextSort', () => {
  it('点新列从降序开始，点同一列来回切', () => {
    expect(nextSort({ key: 'effective', direction: 'desc' }, 'mmr')).toEqual({
      key: 'mmr',
      direction: 'desc',
    });
    expect(nextSort({ key: 'mmr', direction: 'desc' }, 'mmr')).toEqual({
      key: 'mmr',
      direction: 'asc',
    });
    expect(nextSort({ key: 'mmr', direction: 'asc' }, 'mmr')).toEqual({
      key: 'mmr',
      direction: 'desc',
    });
  });
});

describe('sortPlayers', () => {
  const rows = [
    row('a', { effective: 700, rankTier: 45, declaredMmr: 4000 }),
    row('b', { effective: 500, rankTier: null, declaredMmr: null }),
    row('c', { effective: 600, rankTier: 71, declaredMmr: null }),
  ];

  it('按 WARROOM 降序 / 升序', () => {
    expect(sortPlayers(rows, { key: 'effective', direction: 'desc' }).map((r) => r.id)).toEqual([
      'a',
      'c',
      'b',
    ]);
    expect(sortPlayers(rows, { key: 'effective', direction: 'asc' }).map((r) => r.id)).toEqual([
      'b',
      'c',
      'a',
    ]);
  });

  it('按段位排序时，没段位的人排在最后（升序也是）', () => {
    expect(sortPlayers(rows, { key: 'rankTier', direction: 'asc' }).map((r) => r.id)).toEqual([
      'a',
      'c',
      'b',
    ]);
    expect(sortPlayers(rows, { key: 'rankTier', direction: 'desc' }).map((r) => r.id)).toEqual([
      'c',
      'a',
      'b',
    ]);
  });

  it('按 MMR 排序时，没填 MMR 的沉底（同为 null 再按 WARROOM 排）', () => {
    expect(sortPlayers(rows, { key: 'mmr', direction: 'desc' }).map((r) => r.id)).toEqual([
      'a',
      'c',
      'b',
    ]);
    // 升序也一样：null 不参与方向翻转，仍然在最后
    expect(sortPlayers(rows, { key: 'mmr', direction: 'asc' }).map((r) => r.id)).toEqual([
      'a',
      'c',
      'b',
    ]);
  });

  it('同值时按 WARROOM 再按 id，顺序稳定', () => {
    const same = [
      row('z', { effective: 500, rankTier: 45 }),
      row('y', { effective: 600, rankTier: 45 }),
      row('x', { effective: 500, rankTier: 45 }),
    ];
    expect(sortPlayers(same, { key: 'rankTier', direction: 'desc' }).map((r) => r.id)).toEqual([
      'y',
      'x',
      'z',
    ]);
  });
});

describe('筛选', () => {
  const rows = [
    row('a', { verification: 'VERIFIED' }),
    row('b', { verification: 'CLAIMED' }),
    row('c', { verification: null }),
    row('d', { verification: 'VERIFIED' }),
  ];

  it('按身份三档筛选，ALL 返回全部', () => {
    expect(filterPlayers(rows, 'ALL').map((r) => r.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(filterPlayers(rows, 'VERIFIED').map((r) => r.id)).toEqual(['a', 'd']);
    expect(filterPlayers(rows, 'CLAIMED').map((r) => r.id)).toEqual(['b']);
    expect(filterPlayers(rows, 'SELF_REPORTED').map((r) => r.id)).toEqual(['c']);
  });

  it('计数与筛选结果一致', () => {
    const counts = verificationCounts(rows);
    expect(counts).toEqual({ ALL: 4, VERIFIED: 2, CLAIMED: 1, SELF_REPORTED: 1 });
    expect(filterPlayers(rows, 'VERIFIED')).toHaveLength(counts.VERIFIED);
  });
});
