/**
 * 注册表单的「说人话」守门人。
 *
 * 起因：邀请码校验失败时前端只显示一句「输入不合法」——既没说是哪个字段，
 * 也没说该怎么改。这里的断言锁住两件事：
 *   1. 邀请码是必填项，缺了要说清"去找管理员要"；
 *   2. 每条提示都得指向具体规则（长度、字符集、示例），不能再出现笼统说法。
 *
 * 文案与前端 LoginPage 的 RULES 逐字一致——改一边就得改另一边。
 */
import { describe, expect, it } from 'vitest';
import { registerSchema, updateProfileSchema } from '@hive/shared';

const BASE = {
  username: 'byc1030',
  displayName: '黑鸟大神',
  email: 'byc1030@example.com',
  password: 'Hive-2026-local',
  inviteCode: 'HIVE-DEV-01',
};

function parse(patch: Record<string, unknown> = {}) {
  return registerSchema.safeParse({ ...BASE, ...patch });
}

/** 取某个字段的第一条提示（前端 applyServerFields 就是这么取的） */
function firstMessage(field: string, patch: Record<string, unknown>) {
  const parsed = parse(patch);
  expect(parsed.success).toBe(false);
  if (parsed.success) return '';
  // flatten 的类型是每个字段一个可选数组，这里按字段名查，所以放宽成索引签名
  const fields = parsed.error.flatten().fieldErrors as Record<string, string[] | undefined>;
  return fields[field]?.[0] ?? '';
}

describe('注册校验', () => {
  it('合法输入通过，邀请码与用户名统一成小写 / 大写规范形式', () => {
    const parsed = registerSchema.safeParse({
      ...BASE,
      inviteCode: 'hive-dev-01',
      username: 'Byc1030',
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.inviteCode).toBe('HIVE-DEV-01');
    expect(parsed.data.username).toBe('byc1030');
  });

  it('邀请码是必填项，缺了要说「去哪要」', () => {
    expect(firstMessage('inviteCode', { inviteCode: '' })).toBe('请填写邀请码——由管理员在群里发放');
  });

  it('邀请码格式错时给出规则和例子，而不是「格式不正确」', () => {
    expect(firstMessage('inviteCode', { inviteCode: 'HIVE' })).toBe(
      '邀请码是 6–16 位字母、数字或短横线，例如 HIVE-DEV-01',
    );
  });

  it('每个必填字段空值时都点名该字段，而不是「输入不合法」', () => {
    const cases: Array<[string, string]> = [
      ['username', '请填写用户名'],
      ['displayName', '请填写显示名——群里怎么称呼你'],
      ['email', '请填写邮箱'],
      ['password', '请设置密码'],
    ];
    for (const [field, expected] of cases) {
      const message = firstMessage(field, { [field]: '' });
      expect(message).toBe(expected);
      expect(message).not.toContain('不合法');
    }
  });

  it('密码不足 10 位时说明长度要求', () => {
    expect(firstMessage('password', { password: 'short' })).toBe('密码至少 10 位');
  });

  it('用户名太短或含非法字符时说明字符集与长度', () => {
    expect(firstMessage('username', { username: 'a' })).toContain('3-24 位');
    expect(firstMessage('username', { username: '带中文的名字' })).toContain('仅限小写字母');
  });

  it('邮箱格式错时给出示例', () => {
    expect(firstMessage('email', { email: 'not-an-email' })).toBe(
      '邮箱格式不正确，例如 name@example.com',
    );
  });
});

describe('updateProfileSchema（编辑资料）', () => {
  it('邮箱统一小写并去掉首尾空格', () => {
    const parsed = updateProfileSchema.safeParse({ email: '  Foo.Bar@QQ.COM  ' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.email).toBe('foo.bar@qq.com');
  });

  it('格式不对时给示例，不是"输入不合法"', () => {
    const parsed = updateProfileSchema.safeParse({ email: 'not-an-email' });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toContain('邮箱格式不正确');
    }
  });

  it('currentPassword 只做形状校验，必不必填由路由按"邮箱有没有变"决定', () => {
    expect(updateProfileSchema.safeParse({ displayName: '新名字' }).success).toBe(true);
    expect(updateProfileSchema.safeParse({ email: 'a@b.cn' }).success).toBe(true);
    expect(updateProfileSchema.safeParse({ email: 'a@b.cn', currentPassword: '' }).success).toBe(
      true,
    );
  });

  it('QQ 号仍按 5-12 位数字校验', () => {
    const bad = updateProfileSchema.safeParse({ qqNumber: 'abc' });
    expect(bad.success).toBe(false);
    const ok = updateProfileSchema.safeParse({ qqNumber: '123456789' });
    expect(ok.success).toBe(true);
  });
});
