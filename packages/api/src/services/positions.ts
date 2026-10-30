/**
 * 位置偏好的规范化与校验（纯函数，可单测）。
 *
 * 为什么要有这一层：位置是分组算法最重要的输入之一，
 * 脏数据（重复志愿、断档的 rank、越界位置）不会让接口报错，
 * 只会让分组结果变得莫名其妙。所以规则集中在这里，拒绝而不是"尽量纠正"。
 */
export const POSITION_MIN = 1;
export const POSITION_MAX = 5;
export const MAX_ENTRIES = 5;

export interface PositionEntry {
  position: number;
  rank: number;
  proficiency: number;
}

export type PositionRejection =
  | 'NOT_ARRAY'
  | 'EMPTY'
  | 'TOO_MANY'
  | 'BAD_POSITION'
  | 'BAD_RANK'
  | 'BAD_PROFICIENCY'
  | 'DUPLICATE_POSITION'
  | 'DUPLICATE_RANK'
  | 'NON_CONTIGUOUS_RANK';

export type NormalizeResult =
  | { ok: true; positions: PositionEntry[] }
  | { ok: false; reason: PositionRejection };

function isInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

/**
 * 规则：
 *   · 1..5 个条目，可以为空（清空偏好）
 *   · position 唯一，rank 唯一
 *   · rank 必须从 1 连续递增，不能出现 1、3 跳档
 *   · proficiency 缺省 50，范围 0..100
 */
export function normalizePositions(input: unknown): NormalizeResult {
  if (!Array.isArray(input)) return { ok: false, reason: 'NOT_ARRAY' };
  if (input.length > MAX_ENTRIES) return { ok: false, reason: 'TOO_MANY' };

  const positions: PositionEntry[] = [];

  for (const raw of input) {
    if (typeof raw !== 'object' || raw === null) return { ok: false, reason: 'NOT_ARRAY' };
    const entry = raw as { position?: unknown; rank?: unknown; proficiency?: unknown };

    if (!isInt(entry.position) || entry.position < POSITION_MIN || entry.position > POSITION_MAX) {
      return { ok: false, reason: 'BAD_POSITION' };
    }
    if (!isInt(entry.rank) || entry.rank < 1 || entry.rank > MAX_ENTRIES) {
      return { ok: false, reason: 'BAD_RANK' };
    }
    const proficiency = entry.proficiency === undefined ? 50 : entry.proficiency;
    if (!isInt(proficiency) || proficiency < 0 || proficiency > 100) {
      return { ok: false, reason: 'BAD_PROFICIENCY' };
    }

    positions.push({ position: entry.position, rank: entry.rank, proficiency });
  }

  if (positions.length === 0) return { ok: true, positions };

  const seenPositions = new Set<number>();
  const seenRanks = new Set<number>();
  for (const entry of positions) {
    if (seenPositions.has(entry.position)) return { ok: false, reason: 'DUPLICATE_POSITION' };
    if (seenRanks.has(entry.rank)) return { ok: false, reason: 'DUPLICATE_RANK' };
    seenPositions.add(entry.position);
    seenRanks.add(entry.rank);
  }

  const sorted = [...positions].sort((a, b) => a.rank - b.rank);
  for (let index = 0; index < sorted.length; index += 1) {
    if (sorted[index]?.rank !== index + 1) return { ok: false, reason: 'NON_CONTIGUOUS_RANK' };
  }

  return { ok: true, positions: sorted };
}

/** 把拒绝原因翻译成给人看的话；返回 null 表示未知原因 */
export function explainRejection(reason: PositionRejection): string {
  switch (reason) {
    case 'NOT_ARRAY':
      return '位置偏好必须是数组';
    case 'EMPTY':
      return '至少填写一个位置';
    case 'TOO_MANY':
      return '最多填写 5 个位置';
    case 'BAD_POSITION':
      return '位置必须是 1~5 的整数';
    case 'BAD_RANK':
      return '志愿顺序必须是 1~5 的整数';
    case 'BAD_PROFICIENCY':
      return '熟练度必须是 0~100 的整数';
    case 'DUPLICATE_POSITION':
      return '同一个位置不能重复填写';
    case 'DUPLICATE_RANK':
      return '志愿顺序不能重复';
    case 'NON_CONTIGUOUS_RANK':
      return '志愿顺序必须从 1 开始连续，不能跳档';
    default:
      return null as never;
  }
}
