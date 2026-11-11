import app from './app';
import { handleInboundEmail } from './email';
import { runScheduled } from './jobs/scheduler';
import type { Env } from './env';

export default {
  fetch: app.fetch,
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
