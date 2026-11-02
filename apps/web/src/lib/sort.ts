/**
 * 列表排序的两个小约定。抽出来是因为三张表都要用到，
 * 而且"null 排哪"这种事一旦各写各的，同一份数据在两页顺序会不一样。
 */
export type SortDirection = 'asc' | 'desc';

export interface SortState<K extends string> {
  key: K;
  direction: SortDirection;
}

/** 点同一列切方向；点新列从降序开始（没人想先看最低分） */
export function nextSort<K extends string>(current: SortState<K>, key: K): SortState<K> {
  if (current.key !== key) return { key, direction: 'desc' };
  return { key, direction: current.direction === 'desc' ? 'asc' : 'desc' };
}

/**
 * 比较两个可能为空的数字。
 * **null 永远沉底，不随方向翻转**——升序时把"没填段位"的人顶到最前面，
 * 等于奖励不填资料。
 */
export function compareNullable(
  a: number | null,
  b: number | null,
  direction: SortDirection,
): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return direction === 'asc' ? a - b : b - a;
}
