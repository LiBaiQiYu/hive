/**
 * 「没进阵容的人」的归因规则。
 *
 * 这段逻辑只影响展示，但很容易写歪（把另一个场次的人也列成候补、把临场调整
 * 记成弃赛、把"正选但没排到"漏掉），所以用单测把口径钉住：
 *   · 在本场阵容里的人一律不出现
 *   · 在**赛事其它场次**上过场的人也不出现（他们不是没进阵容）
 *   · ABSENT / MANUAL 要分开，文案不能混
 *   · WAITLIST / CONFIRMED / WITHDRAWN 三种状态各归各的原因
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

/** 默认：本场阵容 = 赛事全部阵容；需要模拟另一场时覆盖 eventLineupUserIds */
const build = (input: {
  substitutions?: SubstitutionOutRow[];
  registrations?: BenchRegistrationRow[];
  lineupUserIds?: string[];
  eventLineupUserIds?: string[];
}) =>
  buildBench({
    substitutions: input.substitutions ?? [],
    registrations: input.registrations ?? [],
    lineupUserIds: new Set(input.lineupUserIds ?? []),
    eventLineupUserIds: new Set(input.eventLineupUserIds ?? input.lineupUserIds ?? []),
  });

describe('未进阵容名单', () => {
  it('阵容里的人不出现（换人流水里也在阵容里时也一样）', () => {
    const rows = build({
      substitutions: [sub({ outUserId: 'u1' })],
      registrations: [reg({ userId: 'r1' }), reg({ userId: 'r2', displayName: '阵容内' })],
      lineupUserIds: ['u1', 'r2'],
    });
    expect(rows.map((row) => row.userId)).toEqual(['r1']);
  });

  it('在赛事另一场阵容里的人不算"没进阵容"', () => {
    const rows = build({
      registrations: [reg({ userId: 'other-match', status: 'CONFIRMED' })],
      lineupUserIds: [], // 本场没有他
      eventLineupUserIds: ['other-match'], // 但他在另一场
    });
    expect(rows).toEqual([]);
  });

  it('正选但哪场都没排到 → 未入选（12 人报名只开一场的常见情况）', () => {
    const rows = build({
      registrations: [
        reg({ userId: 'left1', displayName: '没排到的', status: 'CONFIRMED', position: 5 }),
      ],
      lineupUserIds: ['someone-else'],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason).toBe('NOT_SELECTED');
    expect(rows[0]?.detail).toContain('只排 10 人');
  });

  it('ABSENT 是弃赛，MANUAL 是临场调整，文案分开', () => {
    const rows = build({
      substitutions: [
        sub({ outUserId: 'a', outName: '没来的', reason: 'ABSENT', position: 1 }),
        sub({ outUserId: 'b', outName: '被调整的', reason: 'MANUAL', position: 4 }),
      ],
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
    const rows = build({
      registrations: [
        reg({ userId: 'c', displayName: '第三', waitlistPosition: 3, rating: 900 }),
        reg({ userId: 'a', displayName: '第一', waitlistPosition: 1, rating: 100 }),
        reg({ userId: 'x', displayName: '无顺位高分', waitlistPosition: null, rating: 800 }),
      ],
    });
    expect(rows.map((row) => row.userId)).toEqual(['a', 'c', 'x']);
    expect(rows[0]?.rank).toBe(1);
    expect(rows[2]?.rank).toBeNull();
    expect(rows[2]?.detail).toContain('顺位待重排');
  });

  it('退赛的人单独一条，且被换下的人不会重复出现', () => {
    const rows = build({
      substitutions: [sub({ outUserId: 'gone', outName: '换下的' })],
      registrations: [
        reg({ userId: 'gone', status: 'CONFIRMED' }),
        reg({ userId: 'w1', displayName: '退赛的', status: 'WITHDRAWN' }),
      ],
    });
    expect(rows.map((row) => row.reason)).toEqual(['ABSENT', 'WITHDRAWN']);
    expect(rows.filter((row) => row.userId === 'gone')).toHaveLength(1);
    expect(rows[1]?.detail).toBe('截止前退赛');
  });
});
