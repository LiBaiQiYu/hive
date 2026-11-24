/**
 * Cloudflare Workers 入口。
 *
 * 与自建入口（`server/index.ts`）共用同一个 Hono app 与同一套业务逻辑，
 * 区别只在「绑定从哪来」与「谁来触发 Cron」。
 *
 * 注意 `EMAIL` 的用法变了：以前业务代码直接拿 Cloudflare 绑定去 `send(EmailMessage)`，
 * 现在业务侧只认 `{ send({ from, to, raw }) }`（见 `env.ts` 的 `MailBinding`），
 * Cloudflare 的绑定在这里被包一层。这样同一份业务代码才能在 SMTP 上也跑。
 */
import app from './app';
import { handleInboundEmail } from './email';
import { runScheduled } from './jobs/scheduler';
import type { Env } from './env';

/**
 * 把 `send_email` 绑定包成业务侧认识的形状。
 *
 * `cloudflare:email` 只在 Workers 运行时存在，所以这里保持动态 import：
 * 模块顶层不碰它，单测与 Node 构建都不会被拖累。
 */
function wrapMailBinding(env: Env): Env {
  const raw = (env as unknown as { EMAIL?: { send?: (message: unknown) => Promise<void> } }).EMAIL;
  if (!raw || typeof raw.send !== 'function') return env;

  const send = raw.send.bind(raw);
  return {
    ...env,
    EMAIL: {
      async send(message) {
        const { EmailMessage } = await import('cloudflare:email');
        await send(new EmailMessage(message.from, message.to, message.raw));
      },
    },
  };
}

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => app.fetch(request, wrapMailBinding(env), ctx),
  /**
   * Cron 入口：免费版最多 3 条表达式，全部在这里按 cron 分流
   * （每分钟抽干 sync_jobs，每天 18:00 UTC 做维护）。
   */
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Cron 里的异常如果逃出去，日志里只有一条没有上下文的 unhandled rejection。
    // 这里兜住并带上 cron 表达式，排障时能直接看出是哪条任务挂了。
    ctx.waitUntil(
      runScheduled(controller.cron, env).catch((err: unknown) => {
        console.error('scheduled-failed', {
          cron: controller.cron,
          message: err instanceof Error ? err.message : String(err),
        });
      }),
    );
  },
  /**
   * 收信入口：Email Routing 把 reset@ 域名的邮件交给它，回信里带一次性重置链接。
   * 需要在控制台建一条 "Custom address → Send to Worker" 的路由（见 docs/DEVELOPMENT.md §8）。
   */
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    await handleInboundEmail(message, env);
  },
} satisfies ExportedHandler<Env>;
