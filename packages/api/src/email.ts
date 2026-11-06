/**
 * 收信入口：密码自助找回。
 *
 * 免费版不能主动往外发信，但 Email Routing 收信免费且不限量，所以把流程反过来：
 * 玩家用**注册邮箱**发一封信到 `reset@<域名>`，Worker 收到后核对发件人，
 * 用 `message.reply()` 回一封带一次性链接的邮件。
 *
 * 三个检查点（缺一个就等于把账号送给别人）：
 *   1. 发件地址必须与 users.email 完全一致（小写规范化）；
 *   2. 必须通过 Cloudflare 补写的 `Authentication-Results`（dmarc=pass），
 *      否则任何人都能伪造 From 头来重置别人的密码；
 *   3. 同一账号每小时最多申请 3 次，避免被当成回信机器刷。
 *
 * 失败也不区分原因：统一回一句"没有生成链接，可能是……"，
 * 不告诉对方"这个邮箱存在 / 不存在"。
 */
import { EmailMessage } from 'cloudflare:email';
import type { Env } from './env';
import { buildMimeMessage, buildNoticeMail, dmarcPassed, parseAddress } from './email-format';
import {
  RESET_MAX_PER_HOUR,
  RESET_TTL_MINUTES,
  buildResetMail,
  createResetToken,
  recentResetCount,
} from './services/password-reset';

/**
 * Email Routing 的 email() 处理器。
 * 任何异常都吞掉：throw 会让 Cloudflare 给发件人回退信，等于把内部错误暴露出去。
 */
export async function handleInboundEmail(message: ForwardableEmailMessage, env: Env): Promise<void> {
  try {
    const from = parseAddress(message.from) ?? parseAddress(message.headers.get('from'));
    const to = parseAddress(message.to);
    if (!from || !to || from === to) return;

    // 自动回复 / 退信不处理，否则容易和对方的度假助手来回打乒乓球
    const autoSubmitted = message.headers.get('auto-submitted');
    if (autoSubmitted && autoSubmitted.trim().toLowerCase() !== 'no') return;

    // 回信要挂到原邮件线程上：Message-ID 既用于 In-Reply-To，Cloudflare 的
    // reply() 也要求回信本身带 Message-ID（缺了会抛 no message-id set）
    const incomingMessageId = message.headers.get('message-id');

    const user = await env.DB.prepare(
      `SELECT id, display_name AS displayName, status FROM users WHERE email = ?`,
    )
      .bind(from)
      .first<{ id: string; displayName: string; status: string }>();

    const origin = (env.APP_ORIGIN ?? '').replace(/\/+$/, '');
    const canIssue =
      user !== null && user.status === 'ACTIVE' && dmarcPassed(message.headers) && origin.length > 0;

    if (canIssue) {
      const recent = await recentResetCount(env, user.id);
      if (recent < RESET_MAX_PER_HOUR) {
        const { token } = await createResetToken(env, user.id);
        const mail = buildResetMail({
          displayName: user.displayName,
          resetUrl: `${origin}/reset-password?token=${encodeURIComponent(token)}`,
          ttlMinutes: RESET_TTL_MINUTES,
        });
        await message.reply(
          new EmailMessage(
            to,
            from,
            buildMimeMessage({ from: to, to: from, inReplyTo: incomingMessageId, ...mail }),
          ),
        );
        return;
      }
    }

    // 没发链接时把判定依据打出来：线上排查"为什么没收到链接"只看这一行就够
    console.log(
      `[hive] 未生成重置链接 ${JSON.stringify({
        from,
        found: Boolean(user),
        status: user?.status ?? null,
        dmarc: dmarcPassed(message.headers),
        originConfigured: origin.length > 0,
        authResults: (message.headers.get('authentication-results') ?? '').slice(0, 200),
      })}`,
    );

    const notice = buildNoticeMail();
    await message.reply(
      new EmailMessage(
        to,
        from,
        buildMimeMessage({ from: to, to: from, inReplyTo: incomingMessageId, ...notice }),
      ),
    );
  } catch (err) {
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error('[hive] 处理收信失败', detail);
  }
}
