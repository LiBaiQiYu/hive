/**
 * Cron 分发 + 队列抽干。
 *
 * 免费版限制单个 Worker 最多 3 条 Cron，所以所有定时任务共用一个 scheduled handler，
 * 按 cron 表达式分流（见 wrangler.jsonc 的 triggers）。
 */
import type { Env } from '../env';
import { intVar } from '../env';
import { ALGO_VERSION } from '../algorithms/rating';
import { recomputeUserRating } from '../services/rating';
import { reorderOpenEventWaitlists } from '../services/waitlist';
import { closeDueRegistrations } from '../services/event-auto';
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
 *   · 清掉过期一周以上的会话（**不区分是否已撤销**——撤销只是标记，行还是要回收的）
 *   · 按 AUDIT_RETENTION_DAYS 裁剪审计日志
 *   · 清掉一周前就完成的 outbox 记录（DONE 只用于排查，不需要永久保留）
 *   · 给"绑了游戏账号、但 7 天没同步"的玩家排一次 PLAYER_SYNC
 *   · 把算法版本落后的评分重算一遍（v3 改的是实力分口径，旧值必须刷新）
 */
export async function dailyMaintenance(
  env: Env,
): Promise<{ sessions: number; audits: number; jobs: number; queued: number; ratings: number }> {
  const now = Date.now();
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;

  // 注意不要加 `AND revoked_at IS NULL`：那样"用户主动退出/改密码"留下的撤销行会永久堆积
  const sessions = await env.DB.prepare(`DELETE FROM sessions WHERE expires_at < ?`)
    .bind(weekAgo)
    .run();

  // 审计日志按保留天数裁剪（这个 var 之前声明了却没人读，等于无限增长）
  const retentionDays = intVar(env.AUDIT_RETENTION_DAYS, 365);
  const audits = await env.DB.prepare(`DELETE FROM audit_logs WHERE created_at < ?`)
    .bind(now - retentionDays * 24 * 60 * 60 * 1000)
    .run();

  const jobs = await env.DB.prepare(
    `DELETE FROM sync_jobs WHERE status IN ('DONE', 'DEAD') AND finished_at < ?`,
  )
    .bind(weekAgo)
    .run();

  // 补同步的触发条件有两条：
  //   1) 段位数据过期（一周没同步）——常态
  //   2) 头像缺失——绑定那一刻上游没给（Steam Web API 没配 / 账号当时没公开数据），
  //      之后没人再试，就永远是空头像。PLAYER_SYNC 现在会写回昵称与头像（见 handlers.ts），
  //      所以这里排一次就能自愈，不用等满一周。
  const stale = await env.DB.prepare(
    `SELECT ga.user_id AS userId FROM game_accounts ga
       LEFT JOIN player_stats ps ON ps.user_id = ga.user_id
      WHERE ps.fetched_at IS NULL OR ps.fetched_at < ? OR ga.avatar_url IS NULL`,
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

  // 算法升级后，旧版本的 system_rating / attendance_bp 不能继续用。
  // 这里逐条重算（社区只有十几个人，代价可忽略）；管理员也可以立即点「重算全部」。
  const staleRatings = await env.DB.prepare(
    `SELECT user_id AS userId FROM player_ratings WHERE algorithm_version <> ?`,
  )
    .bind(ALGO_VERSION)
    .all<{ userId: string }>();

  let ratings = 0;
  for (const row of staleRatings.results ?? []) {
    await recomputeUserRating(env, row.userId);
    ratings += 1;
  }

  if (ratings > 0) await reorderOpenEventWaitlists(env);

  return {
    sessions: sessions.meta.changes ?? 0,
    audits: audits.meta.changes ?? 0,
    jobs: jobs.meta.changes ?? 0,
    queued,
    ratings,
  };
}

/**
 * 所有 Cron 共用的入口：按表达式分流
 */
export async function runScheduled(cron: string, env: Env): Promise<void> {
  // 只有每日维护那条表达式走维护分支；其余（包括本地
  // `curl /cdn-cgi/local/scheduled` 这种不带 cron 的触发）一律抽队列。
  if (cron === '0 18 * * *') {
    const result = await dailyMaintenance(env);
    console.log('maintenance', JSON.stringify(result));
    return;
  }

  // 每分钟先看有没有到点的赛事：关闭报名 → 封盘 → 分队 → 发布。
  // 放在抽队列之前，是因为它对"玩家看得到的页面"影响最大（到点就该出名单）。
  const closed = await closeDueRegistrations(env);
  if (closed.length > 0) {
    console.log('auto-close', JSON.stringify(closed));
  }

  const summary = await drainJobs(env);
  if (summary.claimed > 0) {
    console.log('drain', JSON.stringify(summary));
  }
}
