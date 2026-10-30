/**
 * 任务 outbox：Workers 免费版没有 Queues，异步任务改为"落表 + Cron 抽干"。
 *
 * 抢占采用租约（lease）而非行锁——D1 没有 SELECT ... FOR UPDATE：
 *   UPDATE sync_jobs SET status='RUNNING', locked_until=?, attempts=attempts+1
 *    WHERE id IN (SELECT id FROM sync_jobs
 *                  WHERE status='PENDING' AND available_at <= ?
 *                  ORDER BY available_at LIMIT 5)
 *   RETURNING *;
 * 执行方崩溃时 locked_until 过期，任务会被回收重排（见 ARCHITECTURE.md §8）。
 *
 * 消息体与 Queues 时代保持一致，升级付费版后只需替换投递实现。
 */
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { TS_NOW } from './_shared';

export const syncJobs = sqliteTable(
  'sync_jobs',
  {
    id: text('id').primaryKey(),
    kind: text('kind', { enum: ['PLAYER_SYNC', 'MATCH_IMPORT', 'RATING_RECOMPUTE'] }).notNull(),
    /** 消息体 JSON，写入前用 Zod 校验 */
    payloadJson: text('payload_json').notNull(),
    /** 去重键，如 player:<userId>；同一键最多一条在途任务 */
    dedupeKey: text('dedupe_key'),
    status: text('status', {
      enum: ['PENDING', 'RUNNING', 'DONE', 'FAILED', 'DEAD'],
    })
      .notNull()
      .default('PENDING'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    /** 退避重试：未到时间不被抢占 */
    availableAt: integer('available_at').notNull(),
    /** 租约截止时间；超时未完成即视为执行方已死 */
    lockedUntil: integer('locked_until'),
    lastError: text('last_error'),
    createdAt: integer('created_at').notNull().default(TS_NOW),
    updatedAt: integer('updated_at').notNull().default(TS_NOW),
    finishedAt: integer('finished_at'),
  },
  (t) => [
    index('idx_sync_jobs_claim').on(t.status, t.availableAt),
    uniqueIndex('ux_sync_jobs_dedupe')
      .on(t.dedupeKey)
      .where(sql`${t.dedupeKey} IS NOT NULL AND ${t.status} IN ('PENDING', 'RUNNING')`),
    index('idx_sync_jobs_finished').on(t.status, t.finishedAt),
  ],
);

export type SyncJob = typeof syncJobs.$inferSelect;
export type NewSyncJob = typeof syncJobs.$inferInsert;
