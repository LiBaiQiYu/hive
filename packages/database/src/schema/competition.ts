/**
 * 赛事、报名、比赛、队伍与阵容。
 *
 * events = 一次社区活动；matches = 活动内的具体场次；teams/team_members = 该场次的阵容。
 * DDL（含 CHECK、部分唯一索引）以 migrations/*.sql 为准。
 */
import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { TS_NOW } from './_shared';
import { users } from './users';

export const events = sqliteTable(
  'events',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    summary: text('summary'),
    rulesMarkdown: text('rules_markdown'),
    format: text('format', { enum: ['DOTA2_5V5'] }).notNull().default('DOTA2_5V5'),
    teamSize: integer('team_size').notNull().default(5),
    /** 必须是 10 的整数倍：不满一场的报名进入候补，不创建残缺比赛 */
    capacity: integer('capacity').notNull().default(20),
    status: text('status', {
      enum: [
        'DRAFT',
        'REGISTRATION_OPEN',
        'REGISTRATION_CLOSED',
        'PUBLISHED',
        'COMPLETED',
        'ARCHIVED',
        'CANCELLED',
      ],
    })
      .notNull()
      .default('DRAFT'),
    registrationOpensAt: integer('registration_opens_at'),
    registrationClosesAt: integer('registration_closes_at'),
    startsAt: integer('starts_at'),
    endsAt: integer('ends_at'),
    createdBy: text('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: integer('created_at').notNull().default(TS_NOW),
    updatedAt: integer('updated_at').notNull().default(TS_NOW),
  },
  (t) => [index('idx_events_status_starts').on(t.status, t.startsAt)],
);

export const registrations = sqliteTable(
  'registrations',
  {
    id: text('id').primaryKey(),
    eventId: text('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: text('status', {
      enum: ['CONFIRMED', 'WAITLIST', 'WITHDRAWN', 'CANCELLED', 'REJECTED'],
    })
      .notNull()
      .default('CONFIRMED'),
    positionPreference: integer('position_preference'),
    secondaryPosition: integer('secondary_position'),
    /* ---- 报名瞬间的评分快照：管理员事后修正评分不得回写 ---- */
    systemRatingSnapshot: integer('system_rating_snapshot').notNull(),
    adminAdjustmentSnapshot: integer('admin_adjustment_snapshot').notNull(),
    effectiveRatingSnapshot: integer('effective_rating_snapshot').notNull(),
    /** 完整位置偏好快照（JSON 文本） */
    positionSnapshot: text('position_snapshot'),
    snapshotAt: integer('snapshot_at').notNull(),
    waitlistPosition: integer('waitlist_position'),
    note: text('note'),
    createdAt: integer('created_at').notNull().default(TS_NOW),
    updatedAt: integer('updated_at').notNull().default(TS_NOW),
    withdrawnAt: integer('withdrawn_at'),
  },
  (t) => [
    // 防重复报名；退赛后重新报名复用同一行，通过 status 流转
    uniqueIndex('ux_registrations_event_user').on(t.eventId, t.userId),
    index('idx_registrations_event_status').on(
      t.eventId,
      t.status,
      t.effectiveRatingSnapshot,
    ),
    index('idx_registrations_user').on(t.userId, t.createdAt),
  ],
);

export const matches = sqliteTable(
  'matches',
  {
    id: text('id').primaryKey(),
    eventId: text('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    matchNo: integer('match_no').notNull(),
    title: text('title'),
    status: text('status', {
      enum: ['DRAFT', 'PUBLISHED', 'IN_PROGRESS', 'COMPLETED', 'VOID'],
    })
      .notNull()
      .default('DRAFT'),
    scheduledAt: integer('scheduled_at'),
    publishedAt: integer('published_at'),
    completedAt: integer('completed_at'),
    /** DOTA2 match_id 超出 32 位，必须 TEXT */
    dotaMatchId: text('dota_match_id'),
    radiantWin: integer('radiant_win', { mode: 'boolean' }),
    durationSeconds: integer('duration_seconds'),
    ratingGap: integer('rating_gap'),
    generationAlgoVersion: text('generation_algo_version'),
    generationSeed: integer('generation_seed'),
    /** 乐观锁，分组编辑器保存与发布校验用 */
    version: integer('version').notNull().default(1),
    createdBy: text('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: integer('created_at').notNull().default(TS_NOW),
    updatedAt: integer('updated_at').notNull().default(TS_NOW),
  },
  (t) => [
    uniqueIndex('ux_matches_event_match_no').on(t.eventId, t.matchNo),
    uniqueIndex('ux_matches_dota_match_id')
      .on(t.dotaMatchId)
      .where(sql`${t.dotaMatchId} IS NOT NULL`),
    index('idx_matches_event_status').on(t.eventId, t.status),
  ],
);

export const teams = sqliteTable(
  'teams',
  {
    id: text('id').primaryKey(),
    matchId: text('match_id')
      .notNull()
      .references(() => matches.id, { onDelete: 'cascade' }),
    /** 冗余：赛事阵容列表页无需 join matches */
    eventId: text('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    side: text('side', { enum: ['RADIANT', 'DIRE'] }).notNull(),
    name: text('name').notNull(),
    totalRating: integer('total_rating').notNull().default(0),
    averageRating: integer('average_rating').notNull().default(0),
    /** 位置覆盖度（基点，10000 = 1..5 全覆盖） */
    positionCoverageBp: integer('position_coverage_bp').notNull().default(0),
    createdAt: integer('created_at').notNull().default(TS_NOW),
    updatedAt: integer('updated_at').notNull().default(TS_NOW),
  },
  (t) => [
    uniqueIndex('ux_teams_match_side').on(t.matchId, t.side),
    index('idx_teams_event').on(t.eventId),
  ],
);

export const teamMembers = sqliteTable(
  'team_members',
  {
    id: text('id').primaryKey(),
    teamId: text('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    matchId: text('match_id')
      .notNull()
      .references(() => matches.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    teamSide: text('team_side', { enum: ['RADIANT', 'DIRE'] }).notNull(),
    assignedPosition: integer('assigned_position').notNull(),
    /** 该玩家与所分配位置的契合度 0..100，编辑器用于提示"位置冲突" */
    positionFitScore: integer('position_fit_score').notNull().default(100),
    systemRatingSnapshot: integer('system_rating_snapshot').notNull(),
    adminAdjustmentSnapshot: integer('admin_adjustment_snapshot').notNull(),
    effectiveRatingSnapshot: integer('effective_rating_snapshot').notNull(),
    isSubstitute: integer('is_substitute', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').notNull().default(TS_NOW),
  },
  (t) => [
    uniqueIndex('ux_team_members_team_user').on(t.teamId, t.userId),
    // 一个玩家在一场比赛中只能进入一个正选阵容
    uniqueIndex('ux_team_members_match_user_active')
      .on(t.matchId, t.userId)
      .where(sql`${t.isSubstitute} = 0`),
    // 一支队伍的一个位置只能站一个人（候补除外）
    uniqueIndex('ux_team_members_team_position')
      .on(t.teamId, t.assignedPosition)
      .where(sql`${t.isSubstitute} = 0`),
    index('idx_team_members_match').on(t.matchId),
    index('idx_team_members_user').on(t.userId, t.matchId),
  ],
);

export const matchPlayerStats = sqliteTable(
  'match_player_stats',
  {
    id: text('id').primaryKey(),
    matchId: text('match_id')
      .notNull()
      .references(() => matches.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    teamSide: text('team_side', { enum: ['RADIANT', 'DIRE'] }).notNull(),
    position: integer('position').notNull(),
    heroId: integer('hero_id').notNull(),
    isWin: integer('is_win', { mode: 'boolean' }).notNull(),
    kills: integer('kills').notNull().default(0),
    deaths: integer('deaths').notNull().default(0),
    assists: integer('assists').notNull().default(0),
    netWorth: integer('net_worth').notNull().default(0),
    gpm: integer('gpm').notNull().default(0),
    xpm: integer('xpm').notNull().default(0),
    lastHits: integer('last_hits').notNull().default(0),
    denies: integer('denies').notNull().default(0),
    heroDamage: integer('hero_damage').notNull().default(0),
    towerDamage: integer('tower_damage').notNull().default(0),
    heroHealing: integer('hero_healing').notNull().default(0),
    itemsJson: text('items_json'),
    createdAt: integer('created_at').notNull().default(TS_NOW),
  },
  (t) => [
    uniqueIndex('ux_match_player_stats_match_user').on(t.matchId, t.userId),
    index('idx_match_player_stats_user').on(t.userId),
  ],
);

/** P2：固定队友。V1.0 只建表，不参与分组算法。 */
export const parties = sqliteTable(
  'parties',
  {
    id: text('id').primaryKey(),
    eventId: text('event_id').references(() => events.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    createdBy: text('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: text('status', { enum: ['ACTIVE', 'DISBANDED'] }).notNull().default('ACTIVE'),
    createdAt: integer('created_at').notNull().default(TS_NOW),
    updatedAt: integer('updated_at').notNull().default(TS_NOW),
  },
  (t) => [index('idx_parties_event').on(t.eventId)],
);

export const partyMembers = sqliteTable(
  'party_members',
  {
    id: text('id').primaryKey(),
    partyId: text('party_id')
      .notNull()
      .references(() => parties.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    joinedAt: integer('joined_at').notNull().default(TS_NOW),
  },
  (t) => [
    uniqueIndex('ux_party_members_party_user').on(t.partyId, t.userId),
    index('idx_party_members_user').on(t.userId),
  ],
);

export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;
export type Registration = typeof registrations.$inferSelect;
export type Match = typeof matches.$inferSelect;
export type Team = typeof teams.$inferSelect;
export type TeamMember = typeof teamMembers.$inferSelect;
export type MatchPlayerStat = typeof matchPlayerStats.$inferSelect;
export type Party = typeof parties.$inferSelect;
