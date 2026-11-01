import app from './app';
import { runScheduled } from './jobs/scheduler';
import type { Env } from './env';

export default {
  fetch: app.fetch,
  /**
   * Cron 入口：免费版最多 3 条表达式，全部在这里按 cron 分流
   * （每分钟抽干 sync_jobs，每天 18:00 UTC 做维护）。
   */
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduled(controller.cron, env));
  },
} satisfies ExportedHandler<Env>;
