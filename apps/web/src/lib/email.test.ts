import { describe, expect, it } from 'vitest';
import { isPlaceholderEmail } from './email';

describe('isPlaceholderEmail', () => {
  it('空值算占位', () => {
    expect(isPlaceholderEmail(null)).toBe(true);
    expect(isPlaceholderEmail(undefined)).toBe(true);
    expect(isPlaceholderEmail('   ')).toBe(true);
    expect(isPlaceholderEmail('not-an-email')).toBe(true);
  });

  it('占位域名大小写、空格不敏感', () => {
    expect(isPlaceholderEmail('admin@hive.local')).toBe(true);
    expect(isPlaceholderEmail(' Admin@HIVE.Local ')).toBe(true);
    expect(isPlaceholderEmail('foo@example.com')).toBe(true);
    expect(isPlaceholderEmail('bar@localhost')).toBe(true);
  });

  it('真实邮箱放行', () => {
    expect(isPlaceholderEmail('625071316@qq.com')).toBe(false);
    expect(isPlaceholderEmail('player@163.com')).toBe(false);
  });
});
