/**
 * 身份与权限：users / sessions / game_accounts
 *
 * 本文件只描述"表与索引"，不描述 CHECK 约束、外键动作与触发器
 * —— 这些由 packages/database/migrations/*.sql 持有（DDL 唯一真源）。
 * 因此禁止用 `drizzle-kit push` 直连任何真实 D1 数据库。
 */
import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { TS_NOW } from './_shared';

/**
 * 邀请码。REGISTRATION_REQUIRE_INVITE=true 时注册必须携带有效邀请码。
 * 先声明本表，users.invite_code_id 才能引用；users 反向引用由闭包延迟求值。
 */
export const inviteCodes = sqliteTable(
  'invite_codes',
  {
    id: text('id').primaryKey(),
    /** 规范形式：大写 6..16 位，仅 [A-Z0-9-]。展示时的连字符由前端补 */
    code: text('code').notNull(),
    label: text('label'),
    /** 0 = 不限次数（官方长期通道） */
    maxUses: integer('max_uses').notNull().default(1),
    usedCount: integer('used_count').notNull().default(0),
    expiresAt: integer('expires_at'),
    revokedAt: integer('revoked_at'),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: integer('created_at').notNull().default(TS_NOW),
    updatedAt: integer('updated_at').notNull().default(TS_NOW),
  },
  (t) => [
    uniqueIndex('ux_invite_codes_code').on(t.code),
    index('idx_invite_codes_created').on(t.createdAt),
  ],
);

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    /** 规范化小写，[a-z0-9_]{3,24}，由服务端校验后写入 */
    username: text('username').notNull(),
    displayName: text('display_name').notNull(),
    /** 规范化小写 */
    email: text('email').notNull(),
    /** pbkdf2_sha256$<iterations>$<salt_b64>$<hash_b64> */
    passwordHash: text('password_hash').notNull(),
    role: text('role', { enum: ['PLAYER', 'ADMIN'] }).notNull().default('PLAYER'),
    status: text('status', { enum: ['ACTIVE', 'SUSPENDED', 'DELETED'] })
      .notNull()
      .default('ACTIVE'),
    qqNumber: text('qq_number'),
    avatarUrl: text('avatar_url'),
    bio: text('bio'),
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: integer('locked_until'),
    lastLoginAt: integer('last_login_at'),
    createdAt: integer('created_at').notNull().default(TS_NOW),
    updatedAt: integer('updated_at').notNull().default(TS_NOW),
    /**
     * 注册来源邀请码。物理上位于末尾（由 0002 的 ALTER TABLE 追加），
     * 因此在本对象中也必须放在最后，才能与 SQL 的列顺序保持一致。
     *
     * 这里刻意不写 `.references()`：users ↔ invite_codes 双向 references 会形成
     * 类型推断环，TS 会把两张表都退化成 any（TS7022）。外键在 0002 的迁移里定义，
     * D1 仍然强制执行，只是 Drizzle 的类型层不知道它。
     */
    inviteCodeId: text('invite_code_id'),
    /**
     * 卡片外观（纯展示，见迁移 0004 / 0009）。枚举值与 @hive/shared 的
     * CARD_MATERIALS / CARD_FRAMES / CARD_FRAME_COLORS / CARD_FRAME_EFFECTS 保持一致；
     * 不一致时 packages/api 的 card-skin 测试会直接失败。
     */
    cardMaterial: text('card_material', {
      enum: ['basic', 'pixel', 'acrylic', 'sparkle', 'holo', 'gold', 'psi', 'infinity'],
    })
      .notNull()
      .default('basic'),
    cardFrame: text('card_frame', {
      enum: ['none', 'hairline', 'double', 'corners', 'bevel', 'frost', 'spark', 'arc'],
    })
      .notNull()
      .default('hairline'),
    /** 发丝线 / 双线的颜色；其他边框忽略，但保留用户的选择 */
    cardFrameColor: text('card_frame_color', {
      enum: ['auto', 'gold', 'ice', 'cyan', 'violet', 'rose', 'emerald', 'rainbow'],
    })
      .notNull()
      .default('auto'),
    /** 发丝线 / 双线的光效 */
    cardFrameEffect: text('card_frame_effect', {
      enum: ['steady', 'breathe', 'blink'],
    })
      .notNull()
      .default('steady'),
    /**
     * 创始人标记（0014 追加，物理位置在末尾）。
     * 只用来解锁创始人专属的东西（目前是「无限镜」卡片材质），与 role 正交：
     * role=ADMIN 是可以授予/撤销的角色，创始人是一次性身份。
     */
    isFounder: integer('is_founder').notNull().default(0),
  },
  (t) => [
    uniqueIndex('ux_users_username').on(t.username),
    uniqueIndex('ux_users_email').on(t.email),
    // 部分唯一索引：只有填写了 QQ 的用户才参与唯一性判定
    uniqueIndex('ux_users_qq_number')
      .on(t.qqNumber)
      .where(sql`${t.qqNumber} IS NOT NULL`),
    index('idx_users_invite_code').on(t.inviteCodeId),
  ],
);

export const sessions = sqliteTable(
  'sessions',
  {
    /** sha256(token) 十六进制，明文 token 只存在于浏览器 Cookie 中 */
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    lastSeenAt: integer('last_seen_at').notNull(),
    userAgent: text('user_agent'),
    /** sha256(ip + 每日轮换盐)，不落原始 IP */
    ipHash: text('ip_hash'),
    revokedAt: integer('revoked_at'),
  },
  (t) => [
    index('idx_sessions_user_id').on(t.userId),
    index('idx_sessions_expires_at').on(t.expiresAt),
  ],
);

/**
 * 密码重置令牌：邮件自助找回用。
 * 只存 sha256(token) 的 base64url，明文只出现在回信里；一次性、30 分钟过期。
 */
export const passwordResets = sqliteTable(
  'password_resets',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: integer('expires_at').notNull(),
    usedAt: integer('used_at'),
    createdAt: integer('created_at').notNull().default(TS_NOW),
  },
  (t) => [
    uniqueIndex('ux_password_resets_token').on(t.tokenHash),
    index('idx_password_resets_user').on(t.userId, t.createdAt),
    index('idx_password_resets_expiry').on(t.expiresAt),
  ],
);

export const gameAccounts = sqliteTable(
  'game_accounts',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * STEAM_OPENID   ：走 OpenID 回过源，归属可信
     * DOTA_ACCOUNT_ID：用户手填数字 ID，只证明该 ID 存在，未证明归属
     */
    provider: text('provider', { enum: ['STEAM_OPENID', 'DOTA_ACCOUNT_ID'] }).notNull(),
    /** 仅 OpenID 路径有值；17 位纯数字字符串（JS Number 无法精确表示 7.6e16） */
    steamId64: text('steam_id64'),
    /** DOTA2 account_id = steam_id64 - 76561197960265728，两条路径都必填 */
    dotaAccountId: integer('dota_account_id').notNull(),
    verification: text('verification', { enum: ['VERIFIED', 'CLAIMED'] }).notNull(),
    personaName: text('persona_name'),
    avatarUrl: text('avatar_url'),
    profileUrl: text('profile_url'),
    isPrimary: integer('is_primary', { mode: 'boolean' }).notNull().default(true),
    /** 只有 OpenID 路径才有验证时间 */
    verifiedAt: integer('verified_at'),
    lastSyncedAt: integer('last_synced_at'),
    createdAt: integer('created_at').notNull().default(TS_NOW),
    updatedAt: integer('updated_at').notNull().default(TS_NOW),
  },
  (t) => [
    // 声明路径没有 steam_id64，故用部分索引
    uniqueIndex('ux_game_accounts_steam_id64')
      .on(t.steamId64)
      .where(sql`${t.steamId64} IS NOT NULL`),
    // 一个 DOTA 账号只能被一个 HIVE 账号占用
    uniqueIndex('ux_game_accounts_dota_account_id').on(t.dotaAccountId),
    // 一人一号：先声明后验证走 UPDATE，不新增行
    uniqueIndex('ux_game_accounts_user_id').on(t.userId),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type GameAccount = typeof gameAccounts.$inferSelect;
export type PasswordReset = typeof passwordResets.$inferSelect;
