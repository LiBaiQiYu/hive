/**
 * D1 outbox 的任务队列（免费版没有 Queues，用一张表当队列）。
 *
 * 语义照搬 Cloudflare Queues：
 *   · 抢占 = 把 PENDING 改成 RUNNING 并写 locked_until（租约）
 *   · 成功 = DONE + finished_at
 *   · 失败 = 退避后回 PENDING，超过 max_attempts 变 DEAD
 *   · 租约过期的 RUNNING 会被回收，避免 Worker 超时导致任务永久卡住
 *
 * 为什么不用 `UPDATE ... RETURNING`：D1 支持，但"先选后改"配合
 * `WHERE status='PENDING'` 的乐观更新更容易看出并发行为，也方便单测。
 */
import type { Env } from '../env';

export type JobKind = 'PLAYER_SYNC' | 'MATCH_IMPORT' | 'RATING_RECOMPUTE';

export interface JobRow {
  id: string;
  kind: JobKind;
  payloadJson: string;
  attempts: number;
  maxAttempts: number;
}

export interface DrainResult {
  claimed: number;
  done: number;
  failed: number;
  dead: number;
  reclaimed: number;
}

/** 退避：1 分钟 → 2 → 4 → 8 …，封顶 30 分钟 */
export function backoffMs(attempts: number): number {
  return Math.min(30 * 60 * 1000, 60 * 1000 * 2 ** Math.max(0, attempts - 1));
}

/** 回收租约过期的 RUNNING；已经用满次数的直接判死，避免 attempts 超过上限 */
export async function reclaimExpired(env: Env, now: number): Promise<number> {
  const dead = await env.DB.prepare(
    `UPDATE sync_jobs SET status = 'DEAD', finished_at = ?, updated_at = ?, last_error = ?
      WHERE status = 'RUNNING' AND locked_until IS NOT NULL AND locked_until < ?
        AND attempts >= max_attempts`,
  )
    .bind(now, now, '租约过期且重试次数已用尽', now)
    .run();

  const back = await env.DB.prepare(
    `UPDATE sync_jobs SET status = 'PENDING', locked_until = NULL, available_at = ?, updated_at = ?
      WHERE status = 'RUNNING' AND locked_until IS NOT NULL AND locked_until < ?
        AND attempts < max_attempts`,
  )
    .bind(now, now, now)
    .run();

  return (dead.meta.changes ?? 0) + (back.meta.changes ?? 0);
}

/** 抢占一批任务：先按 available_at 选，再用带状态守卫的 UPDATE 抢 */
export async function claimJobs(env: Env, now: number, leaseMs: number, limit: number): Promise<JobRow[]> {
  const candidates = await env.DB.prepare(
    `SELECT id, kind, payload_json AS payloadJson, attempts, max_attempts AS maxAttempts
       FROM sync_jobs
      WHERE status = 'PENDING' AND available_at <= ?
      ORDER BY available_at ASC, created_at ASC
      LIMIT ?`,
  )
    .bind(now, limit)
    .all<JobRow>();

  const claimed: JobRow[] = [];
  for (const row of candidates.results ?? []) {
    const result = await env.DB.prepare(
      `UPDATE sync_jobs SET status = 'RUNNING', attempts = attempts + 1, locked_until = ?, updated_at = ?
        WHERE id = ? AND status = 'PENDING'`,
    )
      .bind(now + leaseMs, now, row.id)
      .run();
    if (result.meta.changes) claimed.push(row);
  }
  return claimed;
}

export async function completeJob(env: Env, id: string, now: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE sync_jobs SET status = 'DONE', locked_until = NULL, finished_at = ?, updated_at = ?
      WHERE id = ?`,
  )
    .bind(now, now, id)
    .run();
}

/** 失败：还有次数就退避重排，用尽则判死 */
export async function failJob(
  env: Env,
  job: JobRow,
  message: string,
  now: number,
): Promise<'PENDING' | 'DEAD'> {
  const exhausted = job.attempts + 1 >= job.maxAttempts;
  if (exhausted) {
    await env.DB.prepare(
      `UPDATE sync_jobs SET status = 'DEAD', locked_until = NULL, finished_at = ?,
         last_error = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(now, message.slice(0, 500), now, job.id)
      .run();
    return 'DEAD';
  }

  await env.DB.prepare(
    `UPDATE sync_jobs SET status = 'PENDING', locked_until = NULL, available_at = ?,
       last_error = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(now + backoffMs(job.attempts + 1), message.slice(0, 500), now, job.id)
    .run();
  return 'PENDING';
}
