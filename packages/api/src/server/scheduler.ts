/**
 * 定时任务：用 setTimeout/setInterval 复刻 Workers 的两条 Cron。
 *
 * 为什么不引 node-cron：这里只有两条固定表达式（每分钟 / 每天 18:00 UTC），
 * 自己算下一次到点时间比多一个依赖更省事，也更容易解释。
 *
 * 关键是把**同一套 `runScheduled(cron, env)`** 原样复用 —— 它按 cron 字符串分流，
 * 所以业务侧的抽队列 / 每日维护逻辑一行都不用改。
 */
import { runScheduled } from '../jobs/scheduler';
import type { Env } from '../env';

/** 与 `wrangler.jsonc` 的 triggers.crons 保持一致 */
export const MINUTE_CRON = '* * * * *';
export const DAILY_CRON = '0 18 * * *';

const MINUTE_MS = 60_000;

/** 下一次 UTC 18:00 的毫秒时间戳 */
function nextDailyRun(now: Date): number {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 18, 0, 0, 0));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime();
}

async function runSafely(cron: string, env: Env): Promise<void> {
  try {
    await runScheduled(cron, env);
  } catch (err) {
    // 与 Worker 侧同样兜住异常并带上 cron，否则日志里只有无上下文的反常
    console.error('scheduled-failed', {
      cron,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface SchedulerHandle {
  stop: () => void;
}

export function startScheduler(env: Env): SchedulerHandle {
  let stopped = false;
  let minuteTimer: NodeJS.Timeout | undefined;
  let dailyTimer: NodeJS.Timeout | undefined;
  let firstTimer: NodeJS.Timeout | undefined;

  const tick = (): void => {
    if (stopped) return;
    void runSafely(MINUTE_CRON, env);
  };

  // 每分钟：到点自动关闭报名 → 封盘 → 分队 → 发布，再抽一轮 sync_jobs。
  // 对齐到整分（+2 秒余量），避免与上一轮重叠。
  const firstDelay = MINUTE_MS - (Date.now() % MINUTE_MS) + 2_000;
  firstTimer = setTimeout(() => {
    tick();
    minuteTimer = setInterval(tick, MINUTE_MS);
  }, firstDelay);

  // 每日维护：跑完再排下一次，避免长任务把节奏带偏
  const scheduleDaily = (): void => {
    if (stopped) return;
    const delay = Math.max(nextDailyRun(new Date()) - Date.now(), 1_000);
    dailyTimer = setTimeout(() => {
      void runSafely(DAILY_CRON, env).finally(scheduleDaily);
    }, delay);
  };
  scheduleDaily();

  // 启动时立刻补跑一轮队列：容器重启会丢掉重启期间的每分钟 tick，
  // 不补的话"到点该出的名单"要拖到下一个整分才动
  void runSafely(MINUTE_CRON, env);

  return {
    stop: () => {
      stopped = true;
      if (firstTimer) clearTimeout(firstTimer);
      if (minuteTimer) clearInterval(minuteTimer);
      if (dailyTimer) clearTimeout(dailyTimer);
    },
  };
}
