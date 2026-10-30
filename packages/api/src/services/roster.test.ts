import { describe, expect, it } from 'vitest';
import {
  canFormMatches,
  compareForSelection,
  planFinalize,
  slotsToNextMatch,
  targetMatches,
} from './roster';

describe('targetMatches', () => {
  it('capacity 是目标人数，单位是"场 × 10"', () => {
    expect(targetMatches(10)).toBe(1);
    expect(targetMatches(20)).toBe(2);
    expect(targetMatches(30)).toBe(3);
  });
});

describe('slotsToNextMatch', () => {
  it('16/20 → 再需 4 人凑满第 2 场', () => {
    expect(slotsToNextMatch(16, 20)).toBe(4);
  });

  it('刚好一场时提示还需要一整场的人', () => {
    expect(slotsToNextMatch(10, 20)).toBe(10);
    expect(slotsToNextMatch(0, 20)).toBe(10);
  });

  it('满员时为 null', () => {
    expect(slotsToNextMatch(20, 20)).toBeNull();
    expect(slotsToNextMatch(21, 20)).toBeNull();
  });
});

describe('canFormMatches', () => {
  it('只按整场计算，余数不算', () => {
    expect(canFormMatches(9)).toBe(0);
    expect(canFormMatches(10)).toBe(1);
    expect(canFormMatches(19)).toBe(1);
    expect(canFormMatches(20)).toBe(2);
  });
});

describe('planFinalize', () => {
  it('不足 10 人 → INSUFFICIENT，不改任何数据', () => {
    expect(planFinalize(8, 20, null, false)).toEqual({
      outcome: 'INSUFFICIENT',
      playCount: 0,
      benchCount: 0,
      matches: 0,
    });
  });

  it('正好凑满整数场 → EXACT', () => {
    expect(planFinalize(20, 20, null, false)).toEqual({
      outcome: 'EXACT',
      playCount: 20,
      benchCount: 0,
      matches: 2,
    });
  });

  it('16/20 且没给策略 → POLICY_REQUIRED，服务端不替管理员决定', () => {
    expect(planFinalize(16, 20, null, false)).toEqual({
      outcome: 'POLICY_REQUIRED',
      playCount: 0,
      benchCount: 0,
      matches: 1,
    });
  });

  it('START_PARTIAL：16 人开 1 场，6 人转候补', () => {
    expect(planFinalize(16, 20, 'START_PARTIAL', false)).toEqual({
      outcome: 'START_PARTIAL',
      playCount: 10,
      benchCount: 6,
      matches: 1,
    });
  });

  it('EXTEND：不结算，只是延后报名截止', () => {
    const decision = planFinalize(16, 20, 'EXTEND', false);
    expect(decision.outcome).toBe('EXTEND');
    expect(decision.benchCount).toBe(0);
  });

  it('CANCEL：全员保持 CONFIRMED，赛事取消', () => {
    const decision = planFinalize(16, 20, 'CANCEL', false);
    expect(decision.outcome).toBe('CANCEL');
    expect(decision.playCount).toBe(16);
  });

  it('AUTO_FINALIZE_ODD 打开时允许自动按部分人数开局', () => {
    expect(planFinalize(16, 20, null, true)).toEqual({
      outcome: 'START_PARTIAL',
      playCount: 10,
      benchCount: 6,
      matches: 1,
    });
  });

  it('27 人：2 场 20 人，7 人候补', () => {
    expect(planFinalize(27, 30, 'START_PARTIAL', false)).toEqual({
      outcome: 'START_PARTIAL',
      playCount: 20,
      benchCount: 7,
      matches: 2,
    });
  });
});

describe('compareForSelection', () => {
  const row = (effectiveRating: number, createdAt: number, id: string) => ({
    effectiveRating,
    createdAt,
    id,
  });

  it('评分高者优先', () => {
    const rows = [row(700, 1, 'a'), row(900, 2, 'b')].sort(compareForSelection);
    expect(rows.map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('同分时报名早者优先', () => {
    const rows = [row(900, 5, 'late'), row(900, 1, 'early')].sort(compareForSelection);
    expect(rows.map((r) => r.id)).toEqual(['early', 'late']);
  });

  it('完全同分同时时按 id 兜底，保证顺序稳定', () => {
    const rows = [row(900, 1, 'b'), row(900, 1, 'a')].sort(compareForSelection);
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
  });
});
