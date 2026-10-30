import { describe, expect, it } from 'vitest';
import {
  adjustmentLimit,
  computeEffective,
  computeRating,
  estimateMmr,
  uncertainty,
  type RatingInput,
} from './rating';

const base: RatingInput = {
  rankTier: null,
  declaredMmr: null,
  careerMatches: 0,
  communityPlayed: 0,
  communityRegistered: 0,
};

const veteran: RatingInput = {
  rankTier: 75, // 超凡 5
  declaredMmr: 5200,
  careerMatches: 900,
  communityPlayed: 10,
  communityRegistered: 10,
};

describe('estimateMmr', () => {
  it('优先使用自报 MMR', () => {
    expect(estimateMmr(55, 4300)).toBe(4300);
  });

  it('没有 MMR 时用勋章下界 + 星级推算', () => {
    expect(estimateMmr(51, null)).toBe(3080);
    expect(estimateMmr(53, null)).toBe(3388);
  });

  it('冠绝没有星级，取 5420 基线', () => {
    expect(estimateMmr(80, null)).toBe(5420);
  });

  it('未公开段位返回 null', () => {
    expect(estimateMmr(null, null)).toBeNull();
    expect(estimateMmr(0, null)).toBeNull();
  });
});

describe('computeRating', () => {
  it('两项权重合计 1000', () => {
    const result = computeRating(base);
    expect(result.components.reduce((sum, c) => sum + c.weight, 0)).toBe(1000);
    expect(result.components.map((c) => c.key)).toEqual(['RANK', 'COMMUNITY']);
  });

  it('段位是核心：同一出勤下，超凡 5 远高于中军 2', () => {
    // 自报 MMR 的优先级高于勋章，比较勋章效果时必须把它清掉
    const high = computeRating({ ...veteran, rankTier: 75, declaredMmr: null });
    const low = computeRating({ ...veteran, rankTier: 32, declaredMmr: null });
    expect(high.system).toBeGreaterThan(low.system + 150);
  });

  it('全勤拿满社区分，缺席按比例扣', () => {
    const full = computeRating({ ...veteran, communityPlayed: 10, communityRegistered: 10 });
    const half = computeRating({ ...veteran, communityPlayed: 5, communityRegistered: 10 });
    const none = computeRating({ ...veteran, communityPlayed: 0, communityRegistered: 10 });
    expect(full.system).toBeGreaterThan(half.system);
    expect(half.system).toBeGreaterThan(none.system);
    expect(full.attendanceBp).toBe(10000);
    expect(none.attendanceBp).toBe(0);
  });

  it('没有报名记录的新人不扣分', () => {
    const result = computeRating({ ...veteran, communityPlayed: 0, communityRegistered: 0 });
    expect(result.attendanceBp).toBeNull();
    const community = result.components.find((c) => c.key === 'COMMUNITY');
    expect(community?.value).toBe(1);
    expect(community?.basis).toBe('NO_RECORD');
  });

  it('段位分差要能真实反映出来：9000 与 1000 相差 500 以上', () => {
    const high = computeRating({ rankTier: 80, declaredMmr: 9000, careerMatches: 0, communityPlayed: 0, communityRegistered: 0 });
    const low = computeRating({ rankTier: 11, declaredMmr: 1000, careerMatches: 0, communityPlayed: 0, communityRegistered: 0 });
    expect(high.system - low.system).toBeGreaterThan(500);
  });

  it('没有天梯样本也能靠段位拿到高分，只是不确定度拉满', () => {
    const noCareer = computeRating({ rankTier: 80, declaredMmr: 9000, careerMatches: 0, communityPlayed: 0, communityRegistered: 0 });
    expect(noCareer.system).toBeGreaterThan(800);
    expect(noCareer.confidenceBp).toBe(0);
    expect(uncertainty(noCareer.confidenceBp)).toBe(300);
  });

  it('结果永远在 0..1000', () => {
    const extreme = computeRating({ ...veteran, declaredMmr: 20000 });
    expect(extreme.system).toBeLessThanOrEqual(1000);
    expect(extreme.system).toBeGreaterThanOrEqual(0);
  });
});

describe('computeEffective', () => {
  it('系统分 + 修正后夹到 0..1000', () => {
    expect(computeEffective(720, 50)).toBe(770);
    expect(computeEffective(980, 100)).toBe(1000);
    expect(computeEffective(40, -100)).toBe(0);
  });
});

describe('adjustmentLimit', () => {
  it('置信度越低，管理员能动用的范围越大', () => {
    expect(adjustmentLimit(10000)).toBe(150);
    expect(adjustmentLimit(0)).toBe(500);
    expect(adjustmentLimit(5000)).toBe(325);
  });
});

describe('uncertainty', () => {
  it('置信度越高，展示区间越窄', () => {
    expect(uncertainty(10000)).toBe(0);
    expect(uncertainty(0)).toBe(300);
  });
});
