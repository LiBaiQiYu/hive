/**
 * Cron 分发 + 队列抽干。
 *
 * 免费版限制单个 Worker 最多 3 条 Cron，所以所有定时任务共用一个 scheduled handler，
 * 按 cron 表达式分流（见 wrangler.jsonc 的 triggers）。
 */
import type { Env } from '../env';
import { intVar } from '../env';
import { claimJobs, completeJob, failJob, reclaimExpired } from './queue';
import { handleJob } from './handlers';

export interface DrainSummary {
  claimed: number;
  done: number;
  failed: number;
  dead: number;
  reclaimed: number;
}

/**
 * 抽干一批任务。
 * 串行执行是刻意的：15 人社区的任务量用不着并发，
 * 而且并发抢租约反而更容易把同一玩家算两遍。
 */
export async function drainJobs(env: Env, limit?: number): Promise<DrainSummary> {
  const now = Date.now();
  const batch = limit ?? intVar(env.SYNC_JOB_BATCH_SIZE, 5);
  const leaseMs = intVar(env.SYNC_JOB_LEASE_SECONDS, 120) * 1000;

  const reclaimed = await reclaimExpired(env, now);
  const jobs = await claimJobs(env, now, leaseMs, batch);

  const summary: DrainSummary = { claimed: jobs.length, done: 0, failed: 0, dead: 0, reclaimed };

  for (const job of jobs) {
    try {
      await handleJob(env, job.kind, job.payloadJson);
      await completeJob(env, job.id, Date.now());
      summary.done += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const next = await failJob(env, job, message, Date.now());
      if (next === 'DEAD') summary.dead += 1;
      else summary.failed += 1;
    }
  }

  return summary;
}

/**
 * 每日维护（`0 18 * * *` = 次日 02:00 Asia/Shanghai）：
 *   · 清掉过期一周以上的会话
 *   · 清掉一周前就完成的 outbox 记录（DONE 只用于排查，不需要永久保留）
 *   · 给"绑了游戏账号、但 7 天没同步"的玩家排一次 PLAYER_SYNC
 */
export async function dailyMaintenance(env: Env): Promise<{ sessions: number; jobs: number; queued: number }> {
  const now = Date.now();
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;

  const sessions = await env.DB.prepare(
    `DELETE FROM sessions WHERE expires_at < ? AND revoked_at IS NULL`,
  )
    .bind(weekAgo)
    .run();

  const jobs = await env.DB.prepare(
    `DELETE FROM sync_jobs WHERE status IN ('DONE', 'DEAD') AND finished_at < ?`,
  )
    .bind(weekAgo)
    .run();

  const stale = await env.DB.prepare(
    `SELECT ga.user_id AS userId FROM game_accounts ga
       LEFT JOIN player_stats ps ON ps.user_id = ga.user_id
      WHERE ps.fetched_at IS NULL OR ps.fetched_at < ?`,
  )
    .bind(weekAgo)
    .all<{ userId: string }>();

  let queued = 0;
  for (const row of stale.results ?? []) {
    // dedupe_key 上有部分唯一索引：同一玩家只会有一条在途任务
    const result = await env.DB.prepare(
      `INSERT OR IGNORE INTO sync_jobs (id, kind, payload_json, dedupe_key, status, available_at, created_at, updated_at)
       VALUES (?, 'PLAYER_SYNC', ?, ?, 'PENDING', ?, ?, ?)`,
    )
      .bind(
        `job_${now}_${row.userId}`,
        JSON.stringify({ userId: row.userId }),
        `player:${row.userId}`,
        now,
        now,
        now,
      )
      .run();
    queued += result.meta.changes ?? 0;
  }

  return {
    sessions: sessions.meta.changes ?? 0,
    jobs: jobs.meta.changes ?? 0,
    queued,
  };
}

/** 所有 Cron 共用的入口：按表达式分流 */
export async function runScheduled(cron: string, env: Env): Promise<void> {
  // 只有每日维护那条表达式走维护分支；其余（包括本地
  // `curl /cdn-cgi/local/scheduled` 这种不带 cron 的触发）一律抽队列。
  if (cron === '0 18 * * *') {
    const result = await dailyMaintenance(env);
    console.log('maintenance', JSON.stringify(result));
    return;
  }

  const summary = await drainJobs(env);
  if (summary.claimed > 0) {
    console.log('drain', JSON.stringify(summary));
  }
}
