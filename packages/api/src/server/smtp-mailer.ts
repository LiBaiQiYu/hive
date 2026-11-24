/**
 * 出站发信：SMTP（nodemailer），供 Node 自建部署使用。
 *
 * 与 Workers 侧的 `services/mailer.ts`（`send_email` 绑定）是**同一件事的两种实现**：
 *   · Workers：绑定只放行己方「已验证目的地地址」（免费版限制）；
 *   · 自建：SMTP 没有那个限制 —— 这也是移植后密码找回反而变简单的原因。
 *
 * 两者对外都是 `{ send({ from, to, raw }) }`，业务代码不关心底下是谁。
 */
import { createTransport, type Transporter } from 'nodemailer';

export interface SmtpConfig {
  host: string;
  port: number;
  /** true = 465 隐式 TLS；false = 587/25 走 STARTTLS */
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
  fromName: string;
}

export interface MailBinding {
  send(message: { from: string; to: string; raw: string }): Promise<void>;
}

export function readSmtpConfig(env: Record<string, string | undefined>): SmtpConfig | null {
  const host = env.SMTP_HOST?.trim();
  const from = env.SMTP_FROM?.trim() || env.SMTP_USER?.trim();
  if (!host || !from) return null;

  const parsed = Number.parseInt(env.SMTP_PORT ?? '', 10);
  const port = Number.isFinite(parsed) ? parsed : 587;

  return {
    host,
    port,
    // 465 是隐式 TLS；其余（587/25）走 STARTTLS，nodemailer 会自动协商
    secure: env.SMTP_SECURE ? env.SMTP_SECURE === 'true' : port === 465,
    user: env.SMTP_USER?.trim() || undefined,
    pass: env.SMTP_PASS || undefined,
    from,
    fromName: env.SMTP_FROM_NAME?.trim() || 'HIVE',
  };
}

/** 把一个已经拼好的 RFC822 报文交给 SMTP 发送 */
export function createSmtpMailBinding(config: SmtpConfig): MailBinding {
  let transporter: Transporter | null = null;

  // 懒建连接：启动时不连 SMTP，配错了只是发信失败，不影响站点起来
  const getTransporter = (): Transporter => {
    if (!transporter) {
      transporter = createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth: config.user && config.pass ? { user: config.user, pass: config.pass } : undefined,
        // 自建常见自签证书；真要关校验时显式配 SMTP_TLS_REJECT_UNAUTHORIZED=false
        tls: { rejectUnauthorized: process.env.SMTP_TLS_REJECT_UNAUTHORIZED !== 'false' },
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
      });
    }
    return transporter;
  };

  return {
    async send(message) {
      const info = await getTransporter().sendMail({
        // 用 envelope 而不是 from/to 头，避免被 nodemailer 重新编码中文
        envelope: { from: message.from, to: message.to },
        raw: message.raw,
      });
      // SMTP 明确拒收时 nodemailer 会 throw；这里再兜一层，防它只填 rejected
      const rejected = (info as { rejected?: unknown[] }).rejected;
      if (Array.isArray(rejected) && rejected.length > 0) {
        throw new Error(`SMTP_RECIPIENT_REJECTED: ${rejected.join(', ')}`);
      }
    },
  };
}
