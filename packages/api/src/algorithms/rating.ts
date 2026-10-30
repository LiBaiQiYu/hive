/**
 * WARROOM Rating · 纯函数实现
 *
 * V1 的评分口径（按产品决定收敛过）：
 *   段位 900 + 社区出勤 100 = 1000
 *
 * 为什么砍掉了"近期表现"和"英雄池"：
 *   · 近期胜率在 15 人的社区里噪音极大，20 局样本不足以说明水平；
 *   · 英雄池需要 OpenDota 数据，而大多数人不一定开着公开战绩。
 * 现在只保留两件几乎没有争议的事：你是什么段位，以及你报没报名然后来没来。
 */
export const ALGO_VERSION = 'warroom-v2';

export const WEIGHTS = {
  rank: 900,
  community: 100,
} as const;

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
const MMR_CEILING = 8000;
const BASELINE = 500;

export interface RatingInput {
  rankTier: number | null;
  declaredMmr: number | null;
  /** 天梯累计场次（OpenDota），决定置信度 */
  careerMatches: number;
  /** 实际出场的完赛人数场次 */
  communityPlayed: number;
  /** 报名过、且赛事已经结束的场次 */
  communityRegistered: number;
}

export type ComponentKey = 'RANK' | 'COMMUNITY';

export interface RatedComponent {
  key: ComponentKey;
  weight: number;
  /** 0..1 */
  value: number;
  score: number;
  basis: string;
}

export interface RatingOutput {
  system: number;
  confidenceBp: number;
  components: RatedComponent[];
  estimatedMmr: number | null;
  /** 出勤率（基点），无报名记录时为 null */
  attendanceBp: number | null;
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

export function computeRating(input: RatingInput): RatingOutput {  const mmr = estimateMmr(input.rankTier, input.declaredMmr);

  // ① 段位：MMR 线性映射，8000 以上封顶。没有段位时给 0.3 的中性值
  const rankValue = mmr === null ? 0.3 : clamp(mmr / MMR_CEILING, 0, 1);

  // ② 社区出勤：报名了就来，满分；报了不来按缺席比例扣
  const registered = input.communityRegistered;
  const played = Math.min(input.communityPlayed, registered);
  const attendance = registered > 0 ? played / registered : 1;
  const communityValue = clamp(attendance, 0, 1);

  const components: RatedComponent[] = [
    {
      key: 'RANK',
      weight: WEIGHTS.rank,
      value: rankValue,
      score: Math.round(rankValue * WEIGHTS.rank),
      basis: mmr === null ? 'NO_DATA' : input.declaredMmr !== null ? 'SELF_MMR' : 'MEDAL',
    },
    {
      key: 'COMMUNITY',
      weight: WEIGHTS.community,
      value: communityValue,
      score: Math.round(communityValue * WEIGHTS.community),
      basis: registered > 0 ? 'ATTENDANCE' : 'NO_RECORD',
    },
  ];

  const raw = components.reduce((sum, component) => sum + component.score, 0);

  // 置信度：没有天梯样本时给一个很弱的下限收缩。
  // 这里的取值经过实测调整：下限设成 0.15 会把 9000 分压到 575、1000 分压到 457，
  // 原始 787 的分差只剩 118，评分彻底失去区分度。0.8 让分数基本反映段位，
  // "这人到底有没有那么强"交给徽章（自报/已验证）和管理员修正去表达。
  const confidence = clamp(input.careerMatches / 300, 0, 1);
  const shrunk = Math.round(BASELINE + (raw - BASELINE) * Math.max(confidence, 0.8));

  return {
    system: clamp(shrunk, 0, 1000),
    confidenceBp: Math.round(confidence * 10000),
    components,
    estimatedMmr: mmr,
    attendanceBp: registered > 0 ? Math.round(attendance * 10000) : null,
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
