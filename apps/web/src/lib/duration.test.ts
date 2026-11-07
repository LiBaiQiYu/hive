import { describe, expect, it } from 'vitest';
import { formatDuration } from './duration';

describe('formatDuration', () => {
  it('null / 0 返回占位符', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(0)).toBe('—');
  });

  it('不足一小时用 m:ss', () => {
    expect(formatDuration(45)).toBe('0:45');
    expect(formatDuration(600)).toBe('10:00');
    expect(formatDuration(3599)).toBe('59:59');
  });

  it('满一小时用 h:mm:ss', () => {
    expect(formatDuration(3600)).toBe('1:00:00');
    expect(formatDuration(3930)).toBe('1:05:30');
    expect(formatDuration(14_400)).toBe('4:00:00');
  });
});
