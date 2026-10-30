/**
 * WARROOM 分组算法 · 纯函数实现
 *
 * 规模决定策略：10 人选 5 人只有 C(10,5)=252 种，固定一人到 Radiant 消除镜像后
 * 只剩 C(9,4)=126 种；队内位置指派 5!=120 种。
 * 126 × 240 ≈ 3 万次评估，因此**全枚举拿最优解**，不需要启发式、更不需要 ILP。
 *
 * 代价函数：
 *   cost = 0.7 × |Σrating_A − Σrating_B| + 0.3 × (fitPenalty_A + fitPenalty_B)
 *   fitPenalty_team = 500 − Σ(该队 5 个位置的契合度)   // 每位置满分 100
 *
 * 直觉：实力均衡优先（权重 0.7），位置适配次之。因为在这个社区里，
 * "两边差不多强"是玩家唯一的验收标准；位置打错会难受，但打错位置的局还能玩。
 *
 * 确定性：输入相同 + seed 相同 → 输出必然相同。种子不参与"打分"，
 * 只在"最优点附近的候选池"里挑一个，这样「重新生成」能出不同的阵容，
 * 而不会退化成掷骰子。
 */
import { newId } from '@hive/shared';

export const POSITIONS = [1, 2, 3, 4, 5] as const;
export type Position = (typeof POSITIONS)[number];

export const TEAM_SIZE = 5;
export const ROSTER_SIZE = TEAM_SIZE * 2;

export type Side = 'RADIANT' | 'DIRE';

export interface PositionPreference {
  position: number;
  /** 1 = 第一志愿 */
  rank: number;
  /** 0..100 */
  proficiency: number;
}

export interface BalancePlayer {
  userId: string;
  /** 参与计算的有效评分快照（0..1000） */
  rating: number;
  positions: PositionPreference[];
}

export interface BalancedMember {
  userId: string;
  position: Position;
  fitScore: number;
  rating: number;
}

export interface BalancedTeam {
  side: Side;
  members: BalancedMember[];
  totalRating: number;
  averageRating: number;
  /** 位置覆盖度（基点）：5 个位置中契合度 ≥40 的比例 */
  positionCoverageBp: number;
  fitPenalty: number;
}

export type BalanceWarning =
  | { type: 'POSITION_CONFLICT'; userId: string; position: Position; fitScore: number }
  | { type: 'RATING_GAP_HIGH'; ratingGap: number }
  | { type: 'NO_IDEAL_ASSIGNMENT'; fitPenalty: number };

export interface BalanceResult {
  teams: [BalancedTeam, BalancedTeam];
  ratingGap: number;
  /** 该方案的综合代价 0.7×gap + 0.3×fitPenalty，落库后可复盘"为什么是这个阵容" */
  cost: number;
  warnings: BalanceWarning[];
  algoVersion: string;
  seed: number;
  /** 实际评估的分队方案数，便于回归时确认复杂度没变 */
  candidatesEvaluated: number;
}

export interface BalanceOptions {
  /** 重新生成的种子；0 表示取最优解 */
  seed?: number;
  /** 允许在最优解之上浮动的代价，用于给「重新生成」留出多样性 */
  diversityBudget?: number;
}

export const ALGO_VERSION = 'warroom-balance-v1';

/** 契合度低于此值视为位置冲突，需要在编辑器里高亮 */
export const CONFLICT_THRESHOLD = 40;
/** 两队分差超过此值给出警告 */
export const GAP_WARN_THRESHOLD = 150;

const UNLISTED_FIT = 10;
const FIT_PER_SLOT = 100;
const TEAM_FIT_MAX = FIT_PER_SLOT * TEAM_SIZE;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * 某玩家打某个位置的契合度。
 * 第一志愿 100，之后每降一档 −20；再叠加熟练度修正 (proficiency − 50)/2（±25）。
 * 没填报的位置给 10 分——不是 0，因为"没填"不等于"绝对不能打"。
 */
export function computePositionFit(
  preferences: readonly PositionPreference[],
  position: Position,
): number {
  const preference = preferences.find((p) => p.position === position);
  if (!preference) return UNLISTED_FIT;

  const rank = clamp(Math.round(preference.rank), 1, 5);
  const base = FIT_PER_SLOT - 20 * (rank - 1);
  const proficiencyDelta = (clamp(preference.proficiency, 0, 100) - 50) / 2;
  return clamp(Math.round(base + proficiencyDelta), 0, FIT_PER_SLOT);
}

/** 5! = 120 种位置指派，预先算好，避免在 126 次循环里重复生成 */
const PERMUTATIONS: readonly (readonly number[])[] = (() => {
  const result: number[][] = [];
  const walk = (prefix: number[], rest: number[]): void => {
    if (rest.length === 0) {
      result.push(prefix);
      return;
    }
    for (let i = 0; i < rest.length; i += 1) {
      const next = rest[i];
      if (next === undefined) continue;
      walk([...prefix, next], rest.filter((_, index) => index !== i));
    }
  };
  walk([], [0, 1, 2, 3, 4]);
  return result;
})();

interface Assignment {
  /** slot 下标 0..4 对应位置 1..5，值是该队内的玩家下标 */
  order: number[];
  score: number;
}

/** 给定一支队伍（玩家下标数组），求契合度总和最大的位置指派；同分取字典序最小的，保证确定性 */
function bestAssignment(team: readonly number[], fits: readonly number[][]): Assignment {
  let best: Assignment | null = null;

  for (const permutation of PERMUTATIONS) {
    let score = 0;
    for (let slot = 0; slot < TEAM_SIZE; slot += 1) {
      const playerIndex = team[permutation[slot] ?? 0];
      if (playerIndex === undefined) continue;
      score += fits[playerIndex]?.[slot] ?? 0;
    }
    if (best === null || score > best.score) {
      best = { order: [...permutation], score };
    }
  }

  // PERMUTATIONS 非空且固定长度，best 必然被赋值
  return best as Assignment;
}

function combinations(source: readonly number[], choose: number): number[][] {
  const result: number[][] = [];
  const walk = (start: number, acc: number[]): void => {
    if (acc.length === choose) {
      result.push([...acc]);
      return;
    }
    for (let i = start; i < source.length; i += 1) {
      const value = source[i];
      if (value === undefined) continue;
      acc.push(value);
      walk(i + 1, acc);
      acc.pop();
    }
  };
  walk(0, []);
  return result;
}

interface Candidate {
  radiant: readonly number[];
  dire: readonly number[];
  radiantAssignment: Assignment;
  direAssignment: Assignment;
  ratingGap: number;
  fitPenalty: number;
  cost: number;
  signature: string;
}

/**
 * 计算两队阵容。输入必须是恰好 10 人。
 *
 * 不做"无解"处理——位置指派永远能把 1..5 填满，所谓"无解"只体现在
 * 契合度极低上，因此通过 warnings 暴露，而不是抛错让运营在开赛前卡住。
 */
export function balanceTeams(
  players: readonly BalancePlayer[],
  options: BalanceOptions = {},
): BalanceResult {
  if (players.length !== ROSTER_SIZE) {
    throw new Error(`TEAM_BALANCING_REQUIRES_${ROSTER_SIZE}_PLAYERS: got ${players.length}`);
  }
  if (new Set(players.map((p) => p.userId)).size !== ROSTER_SIZE) {
    throw new Error('TEAM_BALANCING_DUPLICATE_USER');
  }

  const seed = Math.max(0, Math.trunc(options.seed ?? 0));
  const diversityBudget = Math.max(0, options.diversityBudget ?? 40);

  // fits[playerIndex][slot] —— slot 0..4 即位置 1..5
  const fits: number[][] = players.map((player) =>
    POSITIONS.map((position) => computePositionFit(player.positions, position)),
  );
  const ratings = players.map((player) => clamp(Math.round(player.rating), 0, 1000));

  const others = Array.from({ length: ROSTER_SIZE - 1 }, (_, i) => i + 1);
  const candidates: Candidate[] = [];

  // 固定 0 号玩家在 Radiant，消除 A/B 互换的镜像重复：C(9,4) = 126
  for (const picked of combinations(others, TEAM_SIZE - 1)) {
    const radiant = [0, ...picked];
    const dire = others.filter((index) => !radiant.includes(index));

    const radiantAssignment = bestAssignment(radiant, fits);
    const direAssignment = bestAssignment(dire, fits);

    const sum = (indices: readonly number[]): number =>
      indices.reduce((total, index) => total + (ratings[index] ?? 0), 0);

    const ratingGap = Math.abs(sum(radiant) - sum(dire));
    const fitPenalty = TEAM_FIT_MAX * 2 - radiantAssignment.score - direAssignment.score;
    const cost = 0.7 * ratingGap + 0.3 * fitPenalty;

    candidates.push({
      radiant,
      dire,
      radiantAssignment,
      direAssignment,
      ratingGap,
      fitPenalty,
      cost,
      signature: radiant
        .map((index) => players[index]?.userId ?? '')
        .sort()
        .join('|'),
    });
  }

  // 先按代价，再按签名——同分时顺序也必须固定，否则同样的输入会产出不同阵容
  candidates.sort((a, b) => (a.cost - b.cost) || a.signature.localeCompare(b.signature));

  const best = candidates[0];
  if (!best) throw new Error('TEAM_BALANCING_NO_CANDIDATE');

  const pool = candidates.filter((c) => c.cost <= best.cost + diversityBudget);
  const chosen = pool[seed % pool.length] ?? best;

  const buildTeam = (
    side: Side,
    indices: readonly number[],
    assignment: Assignment,
  ): BalancedTeam => {
    // assignment.order[slot] = 该队内第几号成员站在 slot 对应的位置上。
    // 必须按 slot 展开，而不是按成员下标去查 order——那是求逆排列，
    // 写反了会出现"总分正确、但每个人显示的位置和它被评分的那个位置不一致"，
    // 这类错误在界面上完全看不出来（单测就是为了抓它）。
    const members: BalancedMember[] = assignment.order.map((memberIndexInTeam, slot) => {
      const playerIndex = indices[memberIndexInTeam];
      const position = POSITIONS[slot] ?? 1;
      return {
        userId: players[playerIndex ?? -1]?.userId ?? '',
        position,
        fitScore: fits[playerIndex ?? -1]?.[slot] ?? 0,
        rating: ratings[playerIndex ?? -1] ?? 0,
      };
    });

    const totalRating = members.reduce((total, member) => total + member.rating, 0);
    const conflictFree = members.filter((m) => m.fitScore >= CONFLICT_THRESHOLD).length;

    return {
      side,
      members,
      totalRating,
      averageRating: Math.round(totalRating / TEAM_SIZE),
      positionCoverageBp: Math.round((conflictFree / TEAM_SIZE) * 10000),
      fitPenalty: TEAM_FIT_MAX - assignment.score,
    };
  };

  const teams: [BalancedTeam, BalancedTeam] = [
    buildTeam('RADIANT', chosen.radiant, chosen.radiantAssignment),
    buildTeam('DIRE', chosen.dire, chosen.direAssignment),
  ];

  const warnings: BalanceWarning[] = [];
  for (const team of teams) {
    for (const member of team.members) {
      if (member.fitScore < CONFLICT_THRESHOLD) {
        warnings.push({
          type: 'POSITION_CONFLICT',
          userId: member.userId,
          position: member.position,
          fitScore: member.fitScore,
        });
      }
    }
  }
  if (chosen.ratingGap > GAP_WARN_THRESHOLD) {
    warnings.push({ type: 'RATING_GAP_HIGH', ratingGap: chosen.ratingGap });
  }
  if (chosen.fitPenalty > TEAM_FIT_MAX * 0.6) {
    warnings.push({ type: 'NO_IDEAL_ASSIGNMENT', fitPenalty: chosen.fitPenalty });
  }

  return {
    teams,
    ratingGap: chosen.ratingGap,
    cost: chosen.cost,
    warnings,
    algoVersion: ALGO_VERSION,
    seed,
    candidatesEvaluated: candidates.length,
  };
}

/** 生成一个可落库的随机种子，供「重新生成」按钮使用 */
export function randomSeed(): number {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return (buffer[0] ?? 0) % 1_000_000;
}

/** 便于审计日志引用的一次性 id */
export function assignmentTraceId(): string {
  return newId();
}
