import { describe, expect, it } from 'vitest';
import { sortRosterRows, type RosterSortable } from './roster';

type Row = RosterSortable & { name: string };

function row(name: string, status: string, patch: Partial<Row> = {}): Row {
  return {
    id: name,
    name,
    status,
    verification: null,
    effective: 500,
    rankTier: null,
    declaredMmr: null,
    ...patch,
  };
}

const names = (rows: readonly Row[]) => rows.map((item) => item.name);

describe('sortRosterRows', () => {
  it('不排序时原样返回，保持服务端顺序', () => {
    const rows = [row('a', 'CONFIRMED'), row('b', 'WAITLIST'), row('c', 'CONFIRMED')];
    expect(names(sortRosterRows(rows, null))).toEqual(['a', 'b', 'c']);
    // 不能改到入参：调用方拿的是同一个 ref 数组
    expect(rows[0].name).toBe('a');
  });

  it('正选永远排在候补前面，哪怕候补的段位更高', () => {
    const rows = [
      row('wait-high', 'WAITLIST', { rankTier: 80 }),
      row('conf-low', 'CONFIRMED', { rankTier: 20 }),
      row('conf-high', 'CONFIRMED', { rankTier: 60 }),
    ];
    const sorted = sortRosterRows(rows, { key: 'rankTier', direction: 'desc' });
    expect(names(sorted)).toEqual(['conf-high', 'conf-low', 'wait-high']);
  });

  it('组内按所选列排序，方向可切换', () => {
    const rows = [
      row('c', 'CONFIRMED', { declaredMmr: 3000 }),
      row('a', 'CONFIRMED', { declaredMmr: 6000 }),
      row('b', 'CONFIRMED', { declaredMmr: 4000 }),
    ];
    expect(names(sortRosterRows(rows, { key: 'mmr', direction: 'desc' }))).toEqual(['a', 'b', 'c']);
    expect(names(sortRosterRows(rows, { key: 'mmr', direction: 'asc' }))).toEqual(['c', 'b', 'a']);
  });

  it('没有数据的行无论升降序都沉底（不奖励不填资料）', () => {
    const rows = [
      row('none-a', 'CONFIRMED', { declaredMmr: null }),
      row('has', 'CONFIRMED', { declaredMmr: 5000 }),
      row('none-b', 'CONFIRMED', { declaredMmr: null }),
    ];
    expect(names(sortRosterRows(rows, { key: 'mmr', direction: 'desc' }))).toEqual([
      'has',
      'none-a',
      'none-b',
    ]);
    expect(names(sortRosterRows(rows, { key: 'mmr', direction: 'asc' }))).toEqual([
      'has',
      'none-a',
      'none-b',
    ]);
  });
});
