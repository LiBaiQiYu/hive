/**
 * 收信相关的纯函数：地址解析、DMARC 判定、MIME 拼装。
 *
 * 单独放一个文件，是因为 `email.ts` 要 import `cloudflare:email`，
 * 那个模块只在 Workers 运行时里存在，本地 vitest 加载不了；
 * 把能测的部分抽出来，边界与编码就都能用单测钉住。
 */
import { RESET_MAX_PER_HOUR } from './services/password-reset';

const encoder = new TextEncoder();

/** 从 `Name <a@b>` 或裸地址里取出小写地址；不是合法邮箱返回 null */
export function parseAddress(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const match = /<([^>]+)>/.exec(raw);
  const value = (match?.[1] ?? raw).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : null;
}

/**
 * Cloudflare 在投递给 Worker 之前会补一条 `Authentication-Results`，
 * 记录 SPF/DKIM/DMARC 结论。发件人自己也能塞同名头，所以只认
 * 含 `mx.cloudflare.net` 的那条里的 dmarc=pass。
 *
 * 真实头往往带附加信息（`dmarc=pass (p=reject) header.from=qq.com`），
 * 不能拿整段做等值比较——按 ; 切开后前缀匹配。
 */
export function dmarcPassed(headers: Headers): boolean {
  const raw = headers.get('authentication-results');
  if (!raw) return false;
  const lower = raw.toLowerCase();
  if (!lower.includes('mx.cloudflare.net')) return false;
  return lower.split(';').some((token) => /^\s*dmarc=pass\b/.test(token));
}

function toBase64(text: string): string {
  const bytes = encoder.encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function wrap(value: string, width = 76): string {
  const chunks: string[] = [];
  for (let i = 0; i < value.length; i += width) chunks.push(value.slice(i, i + width));
  return chunks.join('\r\n');
}

/**
 * 拼一封纯文本 MIME：主题用 RFC 2047 编码，正文 base64，避免中文被邮局截断。
 *
 * 必须带 `Message-ID`：Cloudflare 的 `message.reply()` 会把回信挂到原邮件的
 * 线程上，缺这个头会直接抛 `no message-id set`（踩过）。
 * 原邮件有 Message-ID 时再补 In-Reply-To / References，让客户端能把两封并成一条会话。
 */
export function buildMimeMessage(input: {
  from: string;
  to: string;
  subject: string;
  text: string;
  inReplyTo?: string | null;
  messageId?: string;
}): string {
  const domain = input.from.split('@')[1] ?? 'localhost';
  const messageId = input.messageId ?? `<${crypto.randomUUID()}@${domain}>`;
  const headers = [
    `From: HIVE <${input.from}>`,
    `To: ${input.to}`,
    `Subject: =?UTF-8?B?${toBase64(input.subject)}?=`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${messageId}`,
  ];
  if (input.inReplyTo) {
    headers.push(`In-Reply-To: ${input.inReplyTo}`, `References: ${input.inReplyTo}`);
  }
  headers.push(
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
  );
  return [...headers, '', wrap(toBase64(input.text))].join('\r\n');
}

/** 没有生成链接时的统一回信：不确认邮箱是否存在 */
export function buildNoticeMail(): { subject: string; text: string } {
  return {
    subject: '[HIVE] 密码重置申请',
    text: [
      '你好：',
      '',
      '我们收到了这封邮件，但没有生成密码重置链接。可能的原因：',
      '',
      '· 发件地址与 HIVE 账号注册时填写的邮箱不一致（必须是同一个地址）；',
      '· 这封邮件是转发来的，或没有通过发件人身份校验；',
      `· 同一账号一小时内申请超过 ${RESET_MAX_PER_HOUR} 次。`,
      '',
      '请用注册邮箱直接发送一封空白邮件到原地址重试；仍然不行的话，联系管理员在后台手动重置。',
      '',
      '—— HIVE（本邮件由系统自动回复，请勿直接回复）',
      '',
    ].join('\r\n'),
  };
}
