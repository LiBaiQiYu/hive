/**
 * 主动发信（Cloudflare Email Sending）。
 *
 * 与收信（email.ts 的 `message.reply()`）不同，这里要**先有收件人**，
 * 而免费版有一条硬限制：只能发给控制台里加过并点过确认信的
 * 「已验证目的地地址」（官方定价页：*Sending to arbitrary recipients requires Workers Paid*）。
 * 所以 `wrangler.jsonc` 里把绑定收窄成 `destination_address`，越界会抛
 * `E_RECIPIENT_NOT_ALLOWED` —— 这不是 bug，是套餐边界。
 *
 * `cloudflare:email` 只在 Workers 运行时存在，单测（vitest）加载不到，
 * 因此这里用动态 import，模块顶层不碰它。
 */
import { buildMimeMessage } from '../email-format';
import type { Env } from '../env';

/** 发信地址：域名必须在 Email Sending 里开通（当前是 cwa1e.top，DKIM = cf2024-1._domainkey） */
export const MAIL_FROM = 'notify@cwa1e.top';

export interface MailInput {
  to: string;
  subject: string;
  text: string;
}

export interface MailResult {
  ok: boolean;
  /** 失败原因（Cloudflare 的错误码前缀尽量保留，方便对照文档） */
  error?: string;
}

/** 绑定是否存在：本地 `pnpm dev` 没有这个绑定，调用方据此走"只记审计不发信" */
export function mailConfigured(env: Env): boolean {
  return typeof env.EMAIL?.send === 'function';
}

export function describeMailError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string' && code.length > 0 ? `${code}: ${err.message}` : err.message;
  }
  return String(err);
}

/** 把 Cloudflare 的错误码翻成"下一步该去控制台点哪里" */
const ERROR_HINTS: Record<string, string> = {
  E_RECIPIENT_NOT_ALLOWED:
    '收件地址不是"已验证目的地"——控制台 → Compute → Email Service → Email Sending → Destination addresses 里加这个地址，点掉确认信再重试（免费版限制）',
  E_SENDER_NOT_ALLOWED:
    '发信地址不允许——把 notify@cwa1e.top 加进 allowed_sender_addresses，或确认域名已在 Email Sending 里开通',
  E_DOMAIN_NOT_ONBOARDED: '发信域名还没在 Email Sending 里开通（需要加 MX/SPF/DKIM/DMARC）',
  EMAIL_BINDING_MISSING: '没有 EMAIL 绑定：本地 `pnpm dev` 不发信；线上检查 wrangler.jsonc 的 send_email',
};

/** 给前端/审计用的中文说明；保留原始错误码方便对照文档 */
export function explainMailError(error: string | undefined): string | undefined {
  if (!error) return undefined;
  const code = error.split(':')[0]?.trim() ?? '';
  const hint = ERROR_HINTS[code];
  return hint ? `${error} → ${hint}` : error;
}

/** 发一封纯文本邮件；永不抛错，失败折成 `{ ok: false, error }` 由调用方统计 */
export async function sendMail(env: Env, input: MailInput): Promise<MailResult> {
  const binding = env.EMAIL;
  if (!binding) return { ok: false, error: 'EMAIL_BINDING_MISSING' };

  try {
    const { EmailMessage } = await import('cloudflare:email');
    const raw = buildMimeMessage({
      from: MAIL_FROM,
      to: input.to,
      subject: input.subject,
      text: input.text,
    });
    await binding.send(new EmailMessage(MAIL_FROM, input.to, raw));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeMailError(err) };
  }
}
