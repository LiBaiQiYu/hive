/**
 * 赛事名额与封盘的纯逻辑。
 *
 * 核心语义：capacity 是**目标人数**（20 = 2 场 × 10 人），不是座位数。
 * 报名期只累计人数、不生成比赛；封盘时才按 floor(confirmed/10) 决定开几场，
 * 余数转候补。这样"先报名的人先打、后报名的人干等"不会发生。
 */
export const TEAM_SIZE = 5;
/** 一场比赛的人数 */
export const MATCH_SIZE = TEAM_SIZE * 2;

export type FinalizePolicy = 'START_PARTIAL' | 'EXTEND' | 'CANCEL';
export type FinalizeOutcome =
  | 'EXACT'
  | 'START_PARTIAL'
  | 'EXTEND'
  | 'CANCEL'
  | 'INSUFFICIENT'
  | 'POLICY_REQUIRED';

export interface FinalizeDecision {
  outcome: FinalizeOutcome;
  /** 保留 CONFIRMED 的人数 */
  playCount: number;
  /** 转 WAITLIST 的人数 */
  benchCount: number;
  /** 可开赛场次 */
  matches: number;
}

/** 目标场次数（capacity 恒为 10 的整数倍，由数据库 CHECK 保证） */
export function targetMatches(capacity: number): number {
  return Math.floor(capacity / MATCH_SIZE);
}

/** 还差几人凑满下一场；满员时返回 null */
export function slotsToNextMatch(confirmed: number, capacity: number): number | null {
  if (confirmed >= capacity) return null;
  const remainder = confirmed % MATCH_SIZE;
  return remainder === 0 ? MATCH_SIZE : MATCH_SIZE - remainder;
}

export function canFormMatches(confirmed: number): number {
  return Math.floor(confirmed / MATCH_SIZE);
}

/**
 * 封盘决策。
 *
 * 人数卡在两档之间时（如 16 人 / 目标 2 场）**不允许服务端静默选一个**：
 * "按 16 人开 1 场、6 人轮空"和"延期凑第 2 场"对社群的影响完全不同，
 * 必须由管理员显式选择。只有 AUTO_FINALIZE_ODD=true 时才允许自动走 START_PARTIAL。
 */
export function planFinalize(
  confirmed: number,
  capacity: number,
  policy: FinalizePolicy | null,
  autoFinalizeOdd: boolean,
): FinalizeDecision {
  const matches = canFormMatches(confirmed);

  if (confirmed < MATCH_SIZE) {
    return { outcome: 'INSUFFICIENT', playCount: 0, benchCount: 0, matches: 0 };
  }

  if (confirmed % MATCH_SIZE === 0) {
    return { outcome: 'EXACT', playCount: confirmed, benchCount: 0, matches };
  }

  const effectivePolicy = policy ?? (autoFinalizeOdd ? 'START_PARTIAL' : null);
  if (effectivePolicy === null) {
    return { outcome: 'POLICY_REQUIRED', playCount: 0, benchCount: 0, matches };
  }

  if (effectivePolicy === 'CANCEL') {
    return { outcome: 'CANCEL', playCount: confirmed, benchCount: 0, matches: 0 };
  }

  if (effectivePolicy === 'EXTEND') {
    return { outcome: 'EXTEND', playCount: confirmed, benchCount: 0, matches };
  }

  const playCount = matches * MATCH_SIZE;
  return {
    outcome: 'START_PARTIAL',
    playCount,
    benchCount: confirmed - playCount,
    matches,
  };
}

export interface SelectionRow {
  /** 有没有段位信息（rank_tier 或 self-reported MMR 任一非空） */
  hasRank: boolean;
  effectiveRating: number;
  createdAt: number;
  id: string;
}

/**
 * 正选名单的挑选顺序：
 *
 *   1. **有段位信息的优先**。没有段位的人，实力分只有 500 中性值；
 *      让这个中性值去压过真实打了 450 分的人，等于奖励"不填资料"。
 *   2. 有效评分高者优先。
 *   3. 同分按报名时间早者优先。
 *   4. id 兜底，否则同样的数据可能排出不同顺序（派发/重算时最容易出问题）。
 *
 * 四个键都必须存在。改动这里必须同步改 routes/admin-events.ts 里封盘用的 ORDER BY，
 * 否则"手动让位"和"自动挑选"会给出两套结果。
 */
export function compareForSelection(a: SelectionRow, b: SelectionRow): number {
  if (a.hasRank !== b.hasRank) return a.hasRank ? -1 : 1;
  if (a.effectiveRating !== b.effectiveRating) return b.effectiveRating - a.effectiveRating;
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id.localeCompare(b.id);
}
