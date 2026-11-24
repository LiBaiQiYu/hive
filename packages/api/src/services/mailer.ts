/**
 * 主动发信：把拼好的报文选一条可用的通路送出去。
 *
 * 两套运行时共用一个入口（`sendMail`），底下由注入的 `env.EMAIL` 决定：
 *   · Workers：`send_email` 绑定，只放行「已验证目的地地址」（免费版限制），
 *     越界抛 `E_RECIPIENT_NOT_ALLOWED` —— 这是套餐边界，不是 bug；
 *   · 自建：入口层用 nodemailer 包成同一形状（见 `server/smtp-mailer.ts`），
 *     没有收件人限制。
 *
 * 因此本文件**不再直接 import `cloudflare:email`**：绑定自己负责构造报文。
 * 这条改动让 mailer 能在 Node 与单测里直接加载。
 */
import { buildMimeMessage } from '../email-format';
import type { Env } from '../env';

/** 发信地址：域名必须在发信服务里开通（Workers 侧是 Email Sending，自建侧是 SMTP 账号） */
export const MAIL_FROM = 'notify@cwa1e.top';

export interface MailInput {
  to: string;
  subject: string;
  text: string;
}

export interface MailResult {
  ok: boolean;
  /** 失败原因（错误码前缀尽量保留，方便对照文档） */
  error?: string;
}

/** 绑定是否存在：本地 `pnpm dev` 与未配 SMTP 的自建实例都没有，调用方据此走「只记审计不发信」 */
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

/** 把错误码翻成"下一步该去哪里配" */
const ERROR_HINTS: Record<string, string> = {
  E_RECIPIENT_NOT_ALLOWED:
    '收件地址不是"已验证目的地"——控制台 → Compute → Email Service → Email Sending → Destination addresses 里加这个地址，点掉确认信再重试（免费版限制）',
  E_SENDER_NOT_ALLOWED:
    '发信地址不允许——把 notify@ 域名加进 allowed_sender_addresses，或确认域名已在 Email Sending 里开通',
  E_DOMAIN_NOT_ONBOARDED: '发信域名还没在 Email Sending 里开通（需要加 MX/SPF/DKIM/DMARC）',
  EMAIL_BINDING_MISSING:
    '没有可用的发信通道：Workers 侧检查 send_email 绑定；自建侧检查 SMTP_HOST / SMTP_FROM（或 SMTP_USER）',
  SMTP_RECIPIENT_REJECTED: 'SMTP 服务器拒收了这个地址——核对收件地址是否存在、有没有被反垃圾拦住',
  EAUTH: 'SMTP 认证失败——核对 SMTP_USER / SMTP_PASS（QQ 邮箱要用"授权码"而不是登录密码）',
  ETIMEDOUT: 'SMTP 连接超时——核对 SMTP_HOST / SMTP_PORT，以及服务器出站 25/465/587 端口是否放行',
};

/** 给前端 / 审计用的中文说明；保留原始错误码方便对照文档 */
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
    const raw = buildMimeMessage({
      from: MAIL_FROM,
      to: input.to,
      subject: input.subject,
      text: input.text,
    });
    await binding.send({ from: MAIL_FROM, to: input.to, raw });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeMailError(err) };
  }
}
