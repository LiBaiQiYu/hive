/**
 * 玩家社交：点赞点踩 + 留言板（一级评论 + 回复）与评论点赞。
 *
 * CHECK 约束只写在 SQL 迁移里（和 rank_source / server_region 一样），
 * 这里保持结构一致即可；Drizzle 侧只用于类型与查询构造。
 */
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { TS_NOW } from './_shared';
import { users } from './users';

export const playerReactions = sqliteTable(
  'player_reactions',
  {
    id: text('id').primaryKey(),
    targetUserId: text('target_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    actorId: text('actor_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** LIKE / DISLIKE：一人一票，可切换可取消 */
    kind: text('kind', { enum: ['LIKE', 'DISLIKE'] }).notNull(),
    createdAt: integer('created_at').notNull().default(TS_NOW),
    updatedAt: integer('updated_at').notNull().default(TS_NOW),
  },
  (t) => [
    uniqueIndex('ux_player_reactions_actor').on(t.actorId, t.targetUserId),
    index('idx_player_reactions_target').on(t.targetUserId, t.kind),
  ],
);

export const comments = sqliteTable(
  'comments',
  {
    id: text('id').primaryKey(),
    /** 留言板主人 */
    targetUserId: text('target_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    authorId: text('author_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * null = 一级评论；非 null = 回复（只允许两级）。
     *
     * 这里**故意不写 `.references()`**：自引用会让 TS 推导成循环（TS7022），
     * 和 users ↔ invite_codes 那个坑是同一个。外键在 SQL 迁移里已经定义了
     * （ON DELETE CASCADE），Drizzle 侧只用于类型与查询构造。
     */
    parentId: text('parent_id'),
    body: text('body').notNull(),
    /** 软删除：删了要留位置，否则回复变孤儿 */
    deletedAt: integer('deleted_at'),
    createdAt: integer('created_at').notNull().default(TS_NOW),
    updatedAt: integer('updated_at').notNull().default(TS_NOW),
  },
  (t) => [
    index('idx_comments_target').on(t.targetUserId, t.parentId, t.createdAt),
    index('idx_comments_parent').on(t.parentId, t.createdAt),
  ],
);

export const commentLikes = sqliteTable(
  'comment_likes',
  {
    id: text('id').primaryKey(),
    commentId: text('comment_id')
      .notNull()
      .references(() => comments.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at').notNull().default(TS_NOW),
  },
  (t) => [
    uniqueIndex('ux_comment_likes').on(t.commentId, t.userId),
    index('idx_comment_likes_user').on(t.userId),
  ],
);
