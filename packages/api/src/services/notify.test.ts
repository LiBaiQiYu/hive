import { describe, expect, it } from 'vitest';
import { isPlaceholderEmail } from './notify';

describe('赛事通知 · 收件地址是否可用', () => {
  it('空值与占位域名一律当作收不到信', () => {
    expect(isPlaceholderEmail(null)).toBe(true);
    expect(isPlaceholderEmail(undefined)).toBe(true);
    expect(isPlaceholderEmail('')).toBe(true);
    expect(isPlaceholderEmail('   ')).toBe(true);
    expect(isPlaceholderEmail('byc1030@hive.local')).toBe(true);
    expect(isPlaceholderEmail('smoke@hive.test')).toBe(true);
    expect(isPlaceholderEmail('x@localhost')).toBe(true);
    expect(isPlaceholderEmail('someone@example.com')).toBe(true);
    // 没有 @ 的脏数据
    expect(isPlaceholderEmail('not-an-email')).toBe(true);
  });

  it('真实地址可用，大小写与首尾空格不影响判定', () => {
    expect(isPlaceholderEmail('625071316@qq.com')).toBe(false);
    expect(isPlaceholderEmail('  A123@163.com  ')).toBe(false);
    expect(isPlaceholderEmail('Mixed.Case@QQ.com')).toBe(false);
  });
});
