import { describe, expect, it } from 'vitest';
import { RESET_TTL_MINUTES, buildResetMail, hashResetToken, randomResetToken } from './password-reset';

describe('randomResetToken', () => {
  it('32 字节随机 → 43 字符 base64url', () => {
    const token = randomResetToken();
    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('每次都不一样', () => {
    const set = new Set(Array.from({ length: 200 }, () => randomResetToken()));
    expect(set.size).toBe(200);
  });
});

describe('hashResetToken', () => {
  it('同一个令牌得到同样的哈希，不同令牌不会撞', async () => {
    const a = randomResetToken();
    const b = randomResetToken();
    expect(await hashResetToken(a)).toBe(await hashResetToken(a));
    expect(await hashResetToken(a)).not.toBe(await hashResetToken(b));
  });

  it('哈希与原令牌无关（库里存的不是明文）', async () => {
    const token = randomResetToken();
    const hash = await hashResetToken(token);
    expect(hash).not.toBe(token);
    expect(hash).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('buildResetMail', () => {
  it('包含重置链接、有效期与一次性说明', () => {
    const mail = buildResetMail({
      displayName: '黑鸟大神',
      resetUrl: 'https://hive.test/reset-password?token=abc',
      ttlMinutes: RESET_TTL_MINUTES,
    });
    expect(mail.subject).toBe('[HIVE] 密码重置');
    expect(mail.text).toContain('黑鸟大神');
    expect(mail.text).toContain('https://hive.test/reset-password?token=abc');
    expect(mail.text).toContain(`${RESET_TTL_MINUTES} 分钟内有效`);
    expect(mail.text).toContain('只能使用一次');
    expect(mail.text).toContain('其他设备上的登录会全部失效');
  });

  it('提醒非本人操作可以忽略', () => {
    const mail = buildResetMail({
      displayName: 'x',
      resetUrl: 'https://hive.test/r',
      ttlMinutes: 30,
    });
    expect(mail.text).toContain('本人操作');
  });
});
