import { describe, expect, it } from 'vitest';
import {
  NEUTRAL_ATTENDANCE_BP,
  compareWaitlist,
  sortWaitlist,
  type WaitlistPriorityRow,
} from './waitlist';

function row(
  id: string,
  attendanceBp: number | null,
  effectiveRating: number,
  createdAt = 1,
): WaitlistPriorityRow {
  return { id, attendanceBp, effectiveRating, createdAt };
}

describe('候补优先级', () => {
  it('出勤高的排前面，即使实力分更低', () => {
    const reliable = row('reliable', 10000, 400);
    const skilled = row('skilled', 0, 900);
    expect(sortWaitlist([skilled, reliable]).map((item) => item.id)).toEqual([
      'reliable',
      'skilled',
    ]);
  });

  it('没有出勤记录按 50% 中性值，不奖励也不惩罚', () => {
    expect(NEUTRAL_ATTENDANCE_BP).toBe(5000);
    const fresh = row('fresh', null, 600);
    const half = row('half', 5000, 400);
    const low = row('low', 2000, 900);
    // 同为 50% 时按实力：fresh 600 > half 400；low 20% 排最后
    expect(sortWaitlist([low, half, fresh]).map((item) => item.id)).toEqual([
      'fresh',
      'half',
      'low',
    ]);
  });

  it('同出勤看实力分，再同分看报名时间与 id', () => {
    const a = row('a', 8000, 700, 100);
    const b = row('b', 8000, 900, 200);
    const c = row('c', 8000, 700, 50);
    const d = row('d', 8000, 700, 100);
    expect(sortWaitlist([a, b, c, d]).map((item) => item.id)).toEqual(['b', 'c', 'a', 'd']);
    expect(compareWaitlist(a, d)).toBeLessThan(0);
  });

  it('不修改原数组', () => {
    const rows = [row('a', 0, 100), row('b', 10000, 100)];
    const sorted = sortWaitlist(rows);
    expect(sorted.map((item) => item.id)).toEqual(['b', 'a']);
    expect(rows.map((item) => item.id)).toEqual(['a', 'b']);
  });
});
