/**
 * 队列健康：outbox 里堆了什么、哪些死了、为什么死。
 *
 * 只读 + 重试，不提供"直接删任务"——排查问题要留下证据。
 */
import { Hono } from 'hono';
import { ApiError } from '@hive/shared';
import type { AppEnv } from '../env';
import { requireAdmin } from '../guard';

export const adminJobRoutes = new Hono<AppEnv>();

adminJobRoutes.get('/', async (c) => {
  requireAdmin(c);

  const [counts, byKind, recent] = await Promise.all([
    c.env.DB.prepare(
      `SELECT status, count(*) AS count FROM sync_jobs GROUP BY status`,
    ).all<{ status: string; count: number }>(),

    c.env.DB.prepare(
      `SELECT kind, status, count(*) AS count FROM sync_jobs GROUP BY kind, status`,
    ).all<{ kind: string; status: string; count: number }>(),

    c.env.DB.prepare(
      `SELECT id, kind, status, attempts, max_attempts AS maxAttempts, available_at AS availableAt,
              last_error AS lastError, created_at AS createdAt, finished_at AS finishedAt
         FROM sync_jobs
        ORDER BY CASE status WHEN 'DEAD' THEN 0 WHEN 'PENDING' THEN 1 WHEN 'RUNNING' THEN 2 ELSE 3 END,
                 created_at DESC
        LIMIT 50`,
    ).all(),
  ]);

  const summary = { PENDING: 0, RUNNING: 0, DONE: 0, FAILED: 0, DEAD: 0 };
  for (const row of counts.results ?? []) {
    if (row.status in summary) summary[row.status as keyof typeof summary] = row.count;
  }

  return c.json({
    data: {
      summary,
      byKind: byKind.results ?? [],
      jobs: recent.results ?? [],
    },
    meta: { requestId: c.get('requestId') },
  });
});

adminJobRoutes.post('/:id/retry', async (c) => {
  requireAdmin(c);

  const job = await c.env.DB.prepare(
    `SELECT id, status, attempts, max_attempts AS maxAttempts FROM sync_jobs WHERE id = ?`,
  )
    .bind(c.req.param('id'))
    .first<{ id: string; status: string; attempts: number; maxAttempts: number }>();
  if (!job) throw new ApiError('NOT_FOUND', '任务不存在');
  if (job.status !== 'DEAD' && job.status !== 'FAILED') {
    throw new ApiError('CONFLICT', '只有 DEAD / FAILED 的任务可以重试');
  }

  const now = Date.now();
  await c.env.DB.prepare(
    `UPDATE sync_jobs SET status = 'PENDING', attempts = 0, locked_until = NULL,
       available_at = ?, last_error = NULL, finished_at = NULL, updated_at = ?
     WHERE id = ?`,
  )
    .bind(now, now, job.id)
    .run();

  return c.json({ data: { id: job.id, status: 'PENDING' }, meta: { requestId: c.get('requestId') } });
});
