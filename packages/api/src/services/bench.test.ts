/**
 * 「没进阵容的人」的归因规则。
 *
 * 这段逻辑只影响展示，但很容易写歪（把另一个场次的人也列成候补、把临场调整
 * 记成弃赛），所以用单测把四条口径钉住：
 *   · 在阵容里的人一律不出现
 *   · ABSENT / MANUAL 要分开，文案不能混
 *   · 候补按顺位排，顺位缺失时按评分兜底
 *   · 同一个人只出现一次
 */
import { describe, expect, it } from 'vitest';
import { buildBench, type BenchRegistrationRow, type SubstitutionOutRow } from './bench';

const sub = (over: Partial<SubstitutionOutRow>): SubstitutionOutRow => ({
  outUserId: 'u1',
  outName: '老王',
  inName: '临时A',
  position: 2,
  reason: 'ABSENT',
  createdAt: 1,
  ...over,
});

const reg = (over: Partial<BenchRegistrationRow>): BenchRegistrationRow => ({
  userId: 'r1',
  displayName: '候补甲',
  status: 'WAITLIST',
  position: 3,
  waitlistPosition: 1,
  rating: 500,
  ...over,
});

describe('未进阵容名单', () => {
  it('阵容里的人不出现（换人流水里也在阵容里时也一样）', () => {
    const rows = buildBench({
      substitutions: [sub({ outUserId: 'u1' })],
      registrations: [reg({ userId: 'r1' }), reg({ userId: 'r2', displayName: '阵容内' })],
      lineupUserIds: new Set(['u1', 'r2']),
    });
    expect(rows.map((row) => row.userId)).toEqual(['r1']);
  });

  it('ABSENT 是弃赛，MANUAL 是临场调整，文案分开', () => {
    const rows = buildBench({
      substitutions: [
        sub({ outUserId: 'a', outName: '没来的', reason: 'ABSENT', position: 1 }),
        sub({ outUserId: 'b', outName: '被调整的', reason: 'MANUAL', position: 4 }),
      ],
      registrations: [],
      lineupUserIds: new Set(),
    });
    expect(rows).toHaveLength(2);
    const absent = rows.find((row) => row.userId === 'a');
    const manual = rows.find((row) => row.userId === 'b');
    expect(absent?.reason).toBe('ABSENT');
    expect(absent?.detail).toContain('未到场');
    expect(manual?.reason).toBe('SUBSTITUTED');
    expect(manual?.detail).toContain('临场调整');
    // 按位置排：1 号位在前
    expect(rows[0]?.userId).toBe('a');
  });

  it('候补按顺位排序，顺位缺失时按评分兜底', () => {
    const rows = buildBench({
      substitutions: [],
      registrations: [
        reg({ userId: 'c', displayName: '第三', waitlistPosition: 3, rating: 900 }),
        reg({ userId: 'a', displayName: '第一', waitlistPosition: 1, rating: 100 }),
        reg({ userId: 'x', displayName: '无顺位高分', waitlistPosition: null, rating: 800 }),
      ],
      lineupUserIds: new Set(),
    });
    expect(rows.map((row) => row.userId)).toEqual(['a', 'c', 'x']);
    expect(rows[0]?.rank).toBe(1);
    expect(rows[2]?.rank).toBeNull();
    expect(rows[2]?.detail).toContain('顺位待重排');
  });

  it('退赛的人单独一条，且和候补靠同一人时不重复', () => {
    const rows = buildBench({
      substitutions: [sub({ outUserId: 'gone', outName: '换下的' })],
      registrations: [
        reg({ userId: 'gone', status: 'WAITLIST' }),
        reg({ userId: 'w1', displayName: '退赛的', status: 'WITHDRAWN' }),
      ],
      lineupUserIds: new Set(),
    });
    expect(rows.map((row) => row.reason)).toEqual(['ABSENT', 'WITHDRAWN']);
    expect(rows.filter((row) => row.userId === 'gone')).toHaveLength(1);
    expect(rows[1]?.detail).toBe('截止前退赛');
  });

  it('CONFIRMED 但没进这套阵容的人不列（属于另一场，不是候补）', () => {
    const rows = buildBench({
      substitutions: [],
      registrations: [reg({ userId: 'other', status: 'CONFIRMED' })],
      lineupUserIds: new Set(),
    });
    expect(rows).toEqual([]);
  });
});
