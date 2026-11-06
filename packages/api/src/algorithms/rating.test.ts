import { describe, expect, it } from 'vitest';
import {
  ALGO_VERSION,
  MMR_TO_RATING_DIVISOR,
  adjustmentLimit,
  computeEffective,
  computeRating,
  estimateMmr,
  rankTierFromMmr,
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

describe('computeRating · 实力分', () => {
  it('实力分 = MMR ÷ 10，且只有 MMR 一项构成', () => {
    const result = computeRating(veteran);
    expect(MMR_TO_RATING_DIVISOR).toBe(10);
    expect(result.system).toBe(520);
    expect(result.components).toEqual([
      {
        key: 'MMR',
        weight: 1000,
        value: 0.52,
        score: 520,
        basis: 'SELF_MMR',
      },
    ]);
    expect(result.components.reduce((sum, c) => sum + c.weight, 0)).toBe(1000);
  });

  it('没有 MMR 时用勋章估算，没有段位时给中性 500', () => {
    const medal = computeRating({ ...base, rankTier: 51 });
    expect(medal.system).toBe(308);
    expect(medal.components[0]?.basis).toBe('MEDAL');

    const none = computeRating(base);
    expect(none.system).toBe(500);
    expect(none.components[0]?.basis).toBe('NO_DATA');
    expect(none.confidenceBp).toBe(0);
  });

  it('段位分差要能真实反映出来：9000 与 1000 相差 800', () => {
    const high = computeRating({ ...base, rankTier: 80, declaredMmr: 9000 });
    const low = computeRating({ ...base, rankTier: 11, declaredMmr: 1000 });
    expect(high.system).toBe(900);
    expect(low.system).toBe(100);
    expect(high.system - low.system).toBe(800);
  });

  it('样本不足不再把分数往 500 收缩，但置信度仍然是 0', () => {
    const noCareer = computeRating({ ...base, rankTier: 80, declaredMmr: 9000 });
    expect(noCareer.system).toBe(900);
    expect(noCareer.confidenceBp).toBe(0);
    expect(uncertainty(noCareer.confidenceBp)).toBe(300);
  });

  it('结果永远在 0..1000', () => {
    const extreme = computeRating({ ...base, declaredMmr: 20000 });
    expect(extreme.system).toBe(1000);

    const zero = computeRating({ ...base, declaredMmr: 0 });
    expect(zero.system).toBe(0);
  });

  it('算法版本已升到 v3', () => {
    expect(ALGO_VERSION).toBe('warroom-v3');
  });
});

describe('管理员设定天梯分', () => {
  it('按目标天梯分重算后，评分正好是 MMR ÷ 10', () => {
    // 原本手填 20000 分的人被改成真实的 3000 分
    const fixed = computeRating({ ...base, rankTier: rankTierFromMmr(3000), declaredMmr: 3000 });
    expect(fixed.system).toBe(300);
    expect(fixed.estimatedMmr).toBe(3000);
    expect(fixed.components[0]?.basis).toBe('SELF_MMR');
  });

  it('段位跟着天梯分一起重算，不会留下旧勋章', () => {
    expect(rankTierFromMmr(3000)).toBe(45); // 统帅 5 星
    expect(rankTierFromMmr(9000)).toBe(80); // 冠绝
    expect(rankTierFromMmr(0)).toBe(11); // 先锋 1 星
  });

  it('清零人工修正后，最终分等于系统分', () => {
    const system = computeRating({ ...base, declaredMmr: 3000 }).system;
    expect(computeEffective(system, 0)).toBe(system);
    // 对照：不清零就会偏出去
    expect(computeEffective(system, 150)).toBe(450);
  });
});

describe('管理员设定段位（只选勋章 + 星级）', () => {
  it('没有天梯分时按勋章区间估算，评分 = 估算 MMR ÷ 10', () => {
    // 统帅 5 星：2310 + 4 × 154 = 2926 → WARROOM 293
    expect(estimateMmr(45, null)).toBe(2926);
    const rating = computeRating({ ...base, rankTier: 45, declaredMmr: null });
    expect(rating.system).toBe(293);
    expect(rating.components[0]?.basis).toBe('MEDAL');
  });

  it('冠绝取 5420 基线，不带星级', () => {
    expect(estimateMmr(80, null)).toBe(5420);
    expect(computeRating({ ...base, rankTier: 80, declaredMmr: null }).system).toBe(542);
  });

  it('残留的天梯分会盖掉段位——段位模式必须把 declared_mmr 清空', () => {
    expect(estimateMmr(45, 9000)).toBe(9000);
  });
});

describe('computeRating · 出勤独立', () => {
  it('全勤 / 缺席不改变实力分，只改变 attendanceBp', () => {
    const full = computeRating({ ...veteran, communityPlayed: 10, communityRegistered: 10 });
    const half = computeRating({ ...veteran, communityPlayed: 5, communityRegistered: 10 });
    const none = computeRating({ ...veteran, communityPlayed: 0, communityRegistered: 10 });

    expect(full.system).toBe(half.system);
    expect(half.system).toBe(none.system);
    expect(full.attendanceBp).toBe(10000);
    expect(half.attendanceBp).toBe(5000);
    expect(none.attendanceBp).toBe(0);
    expect(full.attendancePlayed).toBe(10);
    expect(half.attendancePlayed).toBe(5);
    expect(none.attendancePlayed).toBe(0);
    expect(none.attendanceRegistered).toBe(10);
  });

  it('没有报名记录时 attendanceBp 为 null，不按缺席处理', () => {
    const result = computeRating({ ...veteran, communityPlayed: 0, communityRegistered: 0 });
    expect(result.attendanceBp).toBeNull();
    expect(result.attendancePlayed).toBe(0);
    expect(result.attendanceRegistered).toBe(0);
    expect(result.system).toBe(520);
  });

  it('出场数不会超过报名数', () => {
    const result = computeRating({ ...veteran, communityPlayed: 12, communityRegistered: 10 });
    expect(result.attendancePlayed).toBe(10);
    expect(result.attendanceBp).toBe(10000);
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
