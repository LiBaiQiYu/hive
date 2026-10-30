/**
 * 玩家档案与实力评分：player_stats / player_heroes / player_positions /
 * player_ratings / rating_adjustments
 *
 * CHECK 约束与 DDL 由 migrations/*.sql 持有。
 */
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { TS_NOW } from './_shared';
import { events } from './competition';
import { gameAccounts, users } from './users';

export const playerStats = sqliteTable(
  'player_stats',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    gameAccountId: text('game_account_id').references(() => gameAccounts.id, {
      onDelete: 'set null',
    }),
    /** DOTA2 原始 rank_tier：十位=勋章(1..8)，个位=星级(0..5) */
    rankTier: integer('rank_tier'),
    leaderboardRank: integer('leaderboard_rank'),
    careerMatches: integer('career_matches').notNull().default(0),
    careerWins: integer('career_wins').notNull().default(0),
    recentMatches: integer('recent_matches').notNull().default(0),
    recentWins: integer('recent_wins').notNull().default(0),
    avgKills: real('avg_kills').notNull().default(0),
    avgDeaths: real('avg_deaths').notNull().default(0),
    avgAssists: real('avg_assists').notNull().default(0),
    avgGpm: real('avg_gpm').notNull().default(0),
    avgXpm: real('avg_xpm').notNull().default(0),
    source: text('source', { enum: ['OPENDOTA', 'STRATZ', 'MANUAL'] })
      .notNull()
      .default('OPENDOTA'),
    /** 评分输入明细，用于解释"为什么是 720" */
    algorithmInputsJson: text('algorithm_inputs_json'),
    fetchedAt: integer('fetched_at'),
    syncState: text('sync_state', { enum: ['IDLE', 'QUEUED', 'SYNCING', 'ERROR'] })
      .notNull()
      .default('IDLE'),
    syncError: text('sync_error'),
    createdAt: integer('created_at').notNull().default(TS_NOW),
    updatedAt: integer('updated_at').notNull().default(TS_NOW),
    /* ---- 0003 追加：以下三列必须保持在末尾，与 SQL 的列顺序一致 ---- */
    /** 段位来源：抓取 / 自报 / 管理员设定 */
    rankSource: text('rank_source', {
      enum: ['OPENDOTA', 'STRATZ', 'SELF_REPORTED', 'ADMIN_SET'],
    }),
    /** 玩家自报 MMR，仅展示与参考，不参与 system_rating 计算 */
    declaredMmr: integer('declared_mmr'),
    /** 最近一次成功抓到段位的时间；NULL = 从未抓到（多半没开公开比赛数据） */
    rankCheckedAt: integer('rank_checked_at'),
  },
  (t) => [uniqueIndex('ux_player_stats_user_id').on(t.userId)],
);

export const playerHeroes = sqliteTable(
  'player_heroes',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    heroId: integer('hero_id').notNull(),
    matchesPlayed: integer('matches_played').notNull().default(0),
    wins: integer('wins').notNull().default(0),
    avgGpm: real('avg_gpm'),
    avgXpm: real('avg_xpm'),
    avgNetWorth: real('avg_net_worth'),
    lastPlayedAt: integer('last_played_at'),
    updatedAt: integer('updated_at').notNull().default(TS_NOW),
  },
  (t) => [uniqueIndex('ux_player_heroes_user_hero').on(t.userId, t.heroId)],
);

export const playerPositions = sqliteTable(
  'player_positions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 1=优势路核心 … 5=辅助 */
    position: integer('position').notNull(),
    /** 1 = 第一志愿 */
    preferenceRank: integer('preference_rank').notNull(),
    /** 0..100 */
    proficiency: integer('proficiency').notNull().default(50),
    updatedAt: integer('updated_at').notNull().default(TS_NOW),
  },
  (t) => [
    uniqueIndex('ux_player_positions_user_position').on(t.userId, t.position),
    uniqueIndex('ux_player_positions_user_rank').on(t.userId, t.preferenceRank),
  ],
);

/**
 * 当前生效的三层评分，每个用户一行。
 * effective_rating = clamp(system_rating + admin_adjustment, 0, 1000)，由服务端统一计算，
 * 数据库侧另有 CHECK 兜底防止绕过服务层写入。
 */
export const playerRatings = sqliteTable(
  'player_ratings',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    systemRating: integer('system_rating').notNull().default(500),
    adminAdjustment: integer('admin_adjustment').notNull().default(0),
    /** 冗余存储，用于排行榜排序与报名快照 */
    effectiveRating: integer('effective_rating').notNull().default(500),
    /** 数据置信度（基点），样本越少越接近 0 */
    confidenceBp: integer('confidence_bp').notNull().default(0),
    breakdownJson: text('breakdown_json'),
    algorithmVersion: text('algorithm_version').notNull().default('warroom-v1'),
    computedAt: integer('computed_at'),
    adjustedBy: text('adjusted_by').references(() => users.id, { onDelete: 'set null' }),
    adjustedAt: integer('adjusted_at'),
    updatedAt: integer('updated_at').notNull().default(TS_NOW),
  },
  (t) => [
    uniqueIndex('ux_player_ratings_user_id').on(t.userId),
    index('idx_player_ratings_effective').on(t.effectiveRating),
  ],
);

/** 管理员修正历史：append-only，不更新、不删除 */
export const ratingAdjustments = sqliteTable(
  'rating_adjustments',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    operatorId: text('operator_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    oldAdjustment: integer('old_adjustment').notNull(),
    newAdjustment: integer('new_adjustment').notNull(),
    oldEffective: integer('old_effective').notNull(),
    newEffective: integer('new_effective').notNull(),
    /** 必填，4..200 字符 */
    reason: text('reason').notNull(),
    eventId: text('event_id').references(() => events.id, { onDelete: 'set null' }),
    createdAt: integer('created_at').notNull().default(TS_NOW),
  },
  (t) => [
    index('idx_rating_adjustments_user').on(t.userId, t.createdAt),
    index('idx_rating_adjustments_operator').on(t.operatorId, t.createdAt),
  ],
);

export type PlayerStats = typeof playerStats.$inferSelect;
export type PlayerHero = typeof playerHeroes.$inferSelect;
export type PlayerPosition = typeof playerPositions.$inferSelect;
export type PlayerRating = typeof playerRatings.$inferSelect;
export type RatingAdjustment = typeof ratingAdjustments.$inferSelect;
