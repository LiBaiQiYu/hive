/**
 * WARROOM Rating · 纯函数实现（v3）
 *
 * 实力分 = Dota2 MMR ÷ 10，范围 0..1000：
 *   · 有自报 MMR 就用它；
 *   · 否则用天梯勋章 / 星级估算 MMR；
 *   · 两者都没有时给 500 中性值，置信度 0，交给管理员修正。
 *
 * 出勤不再是评分的一部分：
 *   · attendanceBp 只描述"报名且赛事已结束的场次里，实际出场占比"；
 *   · 它用于候补优先级（出勤高者先转正），不拉低实力分，也不参与分队。
 *
 * 为什么把原来的 900 + 100 拆掉：
 *   技术好但不常来的人会被出勤扣成分数，报名时反而以更低分进池，
 *   既低估实力，也会让分队误判。实力和可靠性是两件事，必须分开表达。
 *
 * 仍然砍掉"近期表现"和"英雄池"：
 *   15 人社区的 20 局样本噪音极大；英雄池需要 OpenDota 数据，
 *   而大多数人不一定开着公开战绩。
 */
export const ALGO_VERSION = 'warroom-v3';

/** MMR → 0..1000 的缩放；10000 分 = 1000 */
export const MMR_TO_RATING_DIVISOR = 10;
/** 没有任何段位 / MMR 时的中性值 */
export const NEUTRAL_RATING = 500;

/** 各勋章对应的 MMR 下界 */
const MEDAL_FLOOR: Record<number, number> = {
  1: 0,
  2: 770,
  3: 1540,
  4: 2310,
  5: 3080,
  6: 3850,
  7: 4620,
  8: 5420,
};

const STAR_STEP = 154;

export interface RatingInput {
  rankTier: number | null;
  declaredMmr: number | null;
  /** 天梯累计场次（OpenDota），只决定置信度 / 修正上限 */
  careerMatches: number;
  /** 实际出场的完赛人数场次 */
  communityPlayed: number;
  /** 报名过、且赛事已经结束的场次 */
  communityRegistered: number;
}

export type ComponentKey = 'MMR';

export interface RatedComponent {
  key: ComponentKey;
  weight: number;
  /** 0..1 */
  value: number;
  score: number;
  basis: 'SELF_MMR' | 'MEDAL' | 'NO_DATA';
}

export interface RatingOutput {
  system: number;
  confidenceBp: number;
  components: RatedComponent[];
  estimatedMmr: number | null;
  /** 出勤率（基点），无报名记录时为 null */
  attendanceBp: number | null;
  /** 实际出场 / 报名且已结束的场次（用于展示，不参与实力分） */
  attendancePlayed: number;
  attendanceRegistered: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** 勋章 → 估算 MMR。冠绝没有星级，直接取区间下界 */
export function estimateMmr(rankTier: number | null, declaredMmr: number | null): number | null {
  if (declaredMmr !== null) return declaredMmr;
  if (rankTier === null || rankTier < 10) return null;

  const medal = Math.floor(rankTier / 10);
  const star = rankTier % 10;
  const floor = MEDAL_FLOOR[medal];
  if (floor === undefined) return null;

  // 冠绝是开放区间且不显示星，取 5420 基线；其余勋章按星级递进
  if (medal === 8) return floor + Math.max(star, 0) * 400;
  return floor + Math.max(star - 1, 0) * STAR_STEP;
}

/**
 * MMR → 勋章与星级（estimateMmr 的反函数）。
 *
 * 规则：按 154 分一星折算，落在哪个勋章区间就取哪个勋章；上限 5 星。
 * 5420 分及以上直接判为冠绝（80），因为冠绝是开放区间、游戏里也不显示星。
 * 天梯分优先于手选段位——它是更具体的输入，两者矛盾时以它为准。
 */
export function rankTierFromMmr(mmr: number): number {
  const value = clamp(Math.round(mmr), 0, 20000);
  if (value >= (MEDAL_FLOOR[8] ?? 5420)) return 80;

  let medal = 1;
  for (let candidate = 8; candidate >= 1; candidate -= 1) {
    if (value >= (MEDAL_FLOOR[candidate] ?? Number.POSITIVE_INFINITY)) {
      medal = candidate;
      break;
    }
  }

  const floor = MEDAL_FLOOR[medal] ?? 0;
  const star = Math.min(5, Math.max(1, 1 + Math.floor((value - floor) / STAR_STEP)));
  return medal * 10 + star;
}

export function computeRating(input: RatingInput): RatingOutput {
  const mmr = estimateMmr(input.rankTier, input.declaredMmr);

  // ① 实力分：MMR ÷ 10，封顶 1000；没有数据时用 500 中性值
  const system = mmr === null
    ? NEUTRAL_RATING
    : clamp(Math.round(mmr / MMR_TO_RATING_DIVISOR), 0, 1000);

  // ② 出勤：独立统计，只用于候补优先级，不进入 system
  const registered = Math.max(0, Math.trunc(input.communityRegistered));
  const played = Math.min(Math.max(0, Math.trunc(input.communityPlayed)), registered);
  const attendance = registered > 0 ? played / registered : null;
  const attendanceBp = attendance === null ? null : Math.round(attendance * 10000);

  const components: RatedComponent[] = [
    {
      key: 'MMR',
      weight: 1000,
      value: clamp(system / 1000, 0, 1),
      score: system,
      basis: mmr === null ? 'NO_DATA' : input.declaredMmr !== null ? 'SELF_MMR' : 'MEDAL',
    },
  ];

  // 置信度不再收缩实力分：样本少只影响"展示的不确定度 / 管理员修正上限"，
  // 不应该把 9000 分的玩家按 500 基准线砍掉。
  const confidence = clamp(input.careerMatches / 300, 0, 1);

  return {
    system,
    confidenceBp: Math.round(confidence * 10000),
    components,
    estimatedMmr: mmr,
    attendanceBp,
    attendancePlayed: played,
    attendanceRegistered: registered,
  };
}

/** 最终评分 = clamp(系统分 + 管理员修正, 0, 1000)，与数据库 CHECK 一致 */
export function computeEffective(system: number, adjustment: number): number {
  return clamp(Math.round(system + adjustment), 0, 1000);
}

/** 管理员修正上限随置信度放宽：150 → 500 */
export function adjustmentLimit(confidenceBp: number, base = 150): number {
  const confidence = clamp(confidenceBp / 10000, 0, 1);
  return Math.round(base + 350 * (1 - confidence));
}

/** UI 展示的不确定度 */
export function uncertainty(confidenceBp: number): number {
  return Math.round(300 * (1 - clamp(confidenceBp / 10000, 0, 1)));
}
