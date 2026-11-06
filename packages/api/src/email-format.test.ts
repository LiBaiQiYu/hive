import { describe, expect, it } from 'vitest';
import { buildMimeMessage, buildNoticeMail, dmarcPassed, parseAddress } from './email-format';

const headers = (init: Record<string, string>) => new Headers(init);

describe('parseAddress', () => {
  it('从 Name <addr> 里取小写地址', () => {
    expect(parseAddress('HIVE <Reset@Example.COM>')).toBe('reset@example.com');
    expect(parseAddress('a@b.cn')).toBe('a@b.cn');
    expect(parseAddress('  spaced@example.com  ')).toBe('spaced@example.com');
  });

  it('不是邮箱就返回 null', () => {
    expect(parseAddress(null)).toBeNull();
    expect(parseAddress('')).toBeNull();
    expect(parseAddress('not-an-email')).toBeNull();
    expect(parseAddress('x@y')).toBeNull();
  });
});

describe('dmarcPassed', () => {
  it('只认 mx.cloudflare.net 那条里的 dmarc=pass', () => {
    const ok = headers({
      'authentication-results': 'mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass',
    });
    expect(dmarcPassed(ok)).toBe(true);
  });

  it('真实头带附加信息时也算通过（dmarc=pass 后面跟原因）', () => {
    const ok = headers({
      'authentication-results':
        'mx.cloudflare.net; spf=pass smtp.mailfrom=qq.com; dkim=pass header.d=qq.com; dmarc=pass (p=reject) header.from=qq.com',
    });
    expect(dmarcPassed(ok)).toBe(true);
  });

  it('没有 Cloudflare 的结论头就不算通过（防伪造 From）', () => {
    expect(dmarcPassed(headers({}))).toBe(false);
    expect(dmarcPassed(headers({ 'authentication-results': 'mx.example.com; dmarc=pass' }))).toBe(
      false,
    );
    expect(
      dmarcPassed(headers({ 'authentication-results': 'mx.cloudflare.net; dmarc=fail' })),
    ).toBe(false);
  });
});

describe('buildMimeMessage', () => {
  it('主题走 RFC 2047 编码，正文是 base64 且能还原', () => {
    const text = '你好，这是一封测试邮件。';
    const raw = buildMimeMessage({
      from: 'reset@hive.test',
      to: 'player@example.com',
      subject: '[HIVE] 密码重置',
      text,
    });

    expect(raw).toContain('From: HIVE <reset@hive.test>');
    expect(raw).toContain('To: player@example.com');
    expect(raw).toMatch(/^Subject: =\?UTF-8\?B\?.+\?=$/m);
    expect(raw).toContain('Content-Transfer-Encoding: base64');

    const body = raw.split('\r\n\r\n')[1] ?? '';
    expect(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8')).toBe(text);
  });

  it('始终带 Message-ID（Cloudflare 的 reply() 缺了它直接抛错）', () => {
    const raw = buildMimeMessage({
      from: 'reset@hive.test',
      to: 'player@example.com',
      subject: 'x',
      text: 'y',
    });
    expect(raw).toMatch(/^Message-ID: <[0-9a-f-]{36}@hive\.test>$/m);
  });

  it('原邮件有 Message-ID 时补 In-Reply-To / References，把回信串成一条会话', () => {
    const raw = buildMimeMessage({
      from: 'reset@hive.test',
      to: 'player@example.com',
      subject: 'x',
      text: 'y',
      inReplyTo: '<original@qq.com>',
    });
    expect(raw).toContain('In-Reply-To: <original@qq.com>');
    expect(raw).toContain('References: <original@qq.com>');
  });

  it('行宽不超过 76 字符（邮局对长行敏感）', () => {
    const raw = buildMimeMessage({
      from: 'a@b.c',
      to: 'd@e.f',
      subject: '[HIVE] 密码重置',
      text: 'x'.repeat(400),
    });
    for (const line of raw.split('\r\n')) {
      expect(line.length).toBeLessThanOrEqual(76);
    }
  });
});

describe('buildNoticeMail', () => {
  it('不确认邮箱是否存在，给出可执行的下一步', () => {
    const mail = buildNoticeMail();
    expect(mail.subject).toContain('密码重置');
    expect(mail.text).toContain('没有生成密码重置链接');
    expect(mail.text).toContain('用注册邮箱直接发送');
  });
});
