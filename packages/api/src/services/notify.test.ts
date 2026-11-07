import { describe, expect, it } from 'vitest';
import { buildStartingSoonMail, formatCst, isPlaceholderEmail } from './notify';

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

describe('赛事通知 · 开赛提醒邮件', () => {
  it('时间按北京时间格式化，跨日也不会错', () => {
    // 2026-11-02 12:00 UTC = 2026-11-02 20:00 CST
    expect(formatCst(Date.UTC(2026, 10, 2, 12, 0))).toBe('2026-11-02 20:00');
    // 2026-11-02 17:30 UTC = 2026-11-03 01:30 CST（跨日）
    expect(formatCst(Date.UTC(2026, 10, 2, 17, 30))).toBe('2026-11-03 01:30');
    // 2026-12-31 16:05 UTC = 2027-01-01 00:05 CST（跨年）
    expect(formatCst(Date.UTC(2026, 11, 31, 16, 5))).toBe('2027-01-01 00:05');
  });

  it('标题带赛事名与开赛时间，正文含报名人数与赛事链接', () => {
    const mail = buildStartingSoonMail({
      displayName: 'byc1030',
      eventTitle: '周五内战 · 19 人局',
      startsAt: Date.UTC(2026, 10, 2, 12, 0),
      confirmed: 19,
      eventUrl: 'https://hive.cwa1e.top/events/abc',
    });

    expect(mail.subject).toBe('[HIVE] 周五内战 · 19 人局 · 2026-11-02 20:00 开赛提醒');
    expect(mail.text).toContain('byc1030 你好');
    expect(mail.text).toContain('2026-11-02 20:00（北京时间）');
    expect(mail.text).toContain('当前 19 人已确认');
    expect(mail.text).toContain('https://hive.cwa1e.top/events/abc');
    // 纯文本 MIME：只能用 CRLF 换行，别混进裸 \n
    expect(mail.text).not.toMatch(/[^\r]\n/);
  });
});
