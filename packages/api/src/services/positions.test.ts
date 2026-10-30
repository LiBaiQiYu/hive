import { describe, expect, it } from 'vitest';
import { explainRejection, normalizePositions } from './positions';

const reasonOf = (input: unknown) => {
  const result = normalizePositions(input);
  return result.ok ? 'OK' : result.reason;
};

describe('normalizePositions', () => {
  it('接受合法的志愿排序，并按 rank 排序返回', () => {
    const result = normalizePositions([
      { position: 4, rank: 3, proficiency: 40 },
      { position: 2, rank: 1, proficiency: 90 },
      { position: 5, rank: 2 },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.positions).toEqual([
      { position: 2, rank: 1, proficiency: 90 },
      { position: 5, rank: 2, proficiency: 50 },
      { position: 4, rank: 3, proficiency: 40 },
    ]);
  });

  it('允许清空偏好（空数组）', () => {
    const result = normalizePositions([]);
    expect(result).toEqual({ ok: true, positions: [] });
  });

  it('拒绝重复位置', () => {
    expect(reasonOf([{ position: 2, rank: 1 }, { position: 2, rank: 2 }])).toBe(
      'DUPLICATE_POSITION',
    );
  });

  it('拒绝重复志愿顺序', () => {
    expect(reasonOf([{ position: 2, rank: 1 }, { position: 3, rank: 1 }])).toBe('DUPLICATE_RANK');
  });

  it('拒绝跳档的志愿顺序（1、3 这种）', () => {
    expect(reasonOf([{ position: 2, rank: 1 }, { position: 3, rank: 3 }])).toBe(
      'NON_CONTIGUOUS_RANK',
    );
  });

  it('拒绝越界的位置与熟练度', () => {
    expect(reasonOf([{ position: 6, rank: 1 }])).toBe('BAD_POSITION');
    expect(reasonOf([{ position: 0, rank: 1 }])).toBe('BAD_POSITION');
    expect(reasonOf([{ position: 2, rank: 1, proficiency: 101 }])).toBe('BAD_PROFICIENCY');
    expect(reasonOf([{ position: 2, rank: 1, proficiency: 12.5 }])).toBe('BAD_PROFICIENCY');
  });

  it('拒绝超过 5 条与非法入参', () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ position: (i % 5) + 1, rank: i + 1 }));
    expect(reasonOf(six)).toBe('TOO_MANY');
    expect(reasonOf(null)).toBe('NOT_ARRAY');
    expect(reasonOf('nope')).toBe('NOT_ARRAY');
  });

  it('每个拒绝原因都有可读文案', () => {
    for (const reason of [
      'NOT_ARRAY',
      'EMPTY',
      'TOO_MANY',
      'BAD_POSITION',
      'BAD_RANK',
      'BAD_PROFICIENCY',
      'DUPLICATE_POSITION',
      'DUPLICATE_RANK',
      'NON_CONTIGUOUS_RANK',
    ] as const) {
      expect(explainRejection(reason)).toBeTruthy();
    }
  });
});
