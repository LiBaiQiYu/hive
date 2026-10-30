-- =============================================================================
-- HIVE V1.0 · 003 身份验证分级 + 段位来源
-- -----------------------------------------------------------------------------
-- 背景：对 Steam OpenID 的恐惧是真实的（虽然它不接触密码），
--       很多人只愿意给出"游戏内数字 ID"（DOTA account_id，如 109902856），
--       或干脆手填段位。于是身份产生两级可信度，段位产生四种来源。
--
-- 本迁移做两件事：
--   1. 重建 game_accounts：同时容纳"OpenID 已验证"与"仅填数字 ID 的声明"；
--   2. 给 player_stats 增加段位来源字段，区分抓取 / 自报 / 管理员设定。
--
-- 注意：game_accounts 旧表要求 steam_id64 NOT NULL 且 verified_at NOT NULL，
--       SQLite 无法用 ALTER 去掉 NOT NULL，只能重建表。
--       重建用"建新表→搬数据→删旧表→改名"的常规做法，且特意手写完整 DDL，
--       不要从 sqlite_master 复制（D1 会把注释里的换行规范化成字面量 \n）。
-- =============================================================================

PRAGMA defer_foreign_keys = on;

-- -----------------------------------------------------------------------------
-- 1. 重建 game_accounts：一个 HIVE 账号最多绑定一个游戏身份
-- -----------------------------------------------------------------------------

CREATE TABLE game_accounts_rebuilt (
  id              TEXT    PRIMARY KEY,
  user_id         TEXT    NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- STEAM_OPENID：走 OpenID 回过源，归属可信
  -- DOTA_ACCOUNT_ID：用户手填数字 ID，只证明了"这个 ID 存在"，没证明"这是他的"
  provider        TEXT    NOT NULL CHECK (provider IN ('STEAM_OPENID', 'DOTA_ACCOUNT_ID')),
  steam_id64      TEXT    CHECK (steam_id64 IS NULL OR
                                 (length(steam_id64) = 17 AND steam_id64 NOT GLOB '*[^0-9]*')),
  -- 32 位账号 ID，OpenDota / STRATZ 的主键，任何 provider 下都必须有
  dota_account_id INTEGER NOT NULL CHECK (dota_account_id > 0),
  verification    TEXT    NOT NULL CHECK (verification IN ('VERIFIED', 'CLAIMED')),
  persona_name    TEXT,
  avatar_url      TEXT,
  profile_url     TEXT,
  is_primary      INTEGER NOT NULL DEFAULT 1 CHECK (is_primary IN (0, 1)),
  verified_at     INTEGER,
  last_synced_at  INTEGER,
  created_at      INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  updated_at      INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  -- OpenID 路径：必须有 steam_id64、必须 VERIFIED、必须有验证时间
  CHECK (provider <> 'STEAM_OPENID'
         OR (steam_id64 IS NOT NULL AND verification = 'VERIFIED' AND verified_at IS NOT NULL)),
  -- 纯声明路径：不许伪装成已验证
  CHECK (provider <> 'DOTA_ACCOUNT_ID'
         OR (steam_id64 IS NULL AND verification = 'CLAIMED')),
  -- 两个 ID 必须自洽：account_id = steam_id64 - 76561197960265728
  -- （SQLite INTEGER 是 64 位，7.6e16 的 SteamID64 可以精确运算；JS 里不行，必须用字符串）
  CHECK (steam_id64 IS NULL
         OR dota_account_id = CAST(steam_id64 AS INTEGER) - 76561197960265728)
);

INSERT INTO game_accounts_rebuilt (
  id, user_id, provider, steam_id64, dota_account_id, verification,
  persona_name, avatar_url, profile_url, is_primary,
  verified_at, last_synced_at, created_at, updated_at
)
SELECT
  id, user_id, 'STEAM_OPENID', steam_id64,
  COALESCE(dota_account_id, CAST(steam_id64 AS INTEGER) - 76561197960265728),
  'VERIFIED',
  persona_name, avatar_url, profile_url, is_primary,
  verified_at, last_synced_at, created_at, updated_at
FROM game_accounts;

DROP TABLE game_accounts;
ALTER TABLE game_accounts_rebuilt RENAME TO game_accounts;

-- 一个 Steam 账号只能绑一次（声明路径没有 steam_id64，故用部分索引）
CREATE UNIQUE INDEX ux_game_accounts_steam_id64 ON game_accounts (steam_id64)
  WHERE steam_id64 IS NOT NULL;
-- 一个 DOTA 账号只能被一个 HIVE 账号占用：防止冒领他人 ID
CREATE UNIQUE INDEX ux_game_accounts_dota_account_id ON game_accounts (dota_account_id);
-- 一人一号（先声明后验证走 UPDATE，不新增行）
CREATE UNIQUE INDEX ux_game_accounts_user_id ON game_accounts (user_id);

-- -----------------------------------------------------------------------------
-- 2. player_stats：段位从哪来的
-- -----------------------------------------------------------------------------

-- OPENDOTA / STRATZ ：接口抓取（需对方开启「公开比赛数据」）
-- SELF_REPORTED     ：玩家自报，不可信但可展示
-- ADMIN_SET         ：管理员根据社区认知直接设定（会写 audit_logs）
ALTER TABLE player_stats ADD COLUMN rank_source TEXT
  CHECK (rank_source IS NULL OR rank_source IN ('OPENDOTA', 'STRATZ', 'SELF_REPORTED', 'ADMIN_SET'));

-- 自报的 MMR 数值。DOTA2 现在不直接显示 MMR，只有第三方工具能算，
-- 因此仅作为展示与参考，不参与 system_rating 计算。
ALTER TABLE player_stats ADD COLUMN declared_mmr INTEGER
  CHECK (declared_mmr IS NULL OR declared_mmr BETWEEN 0 AND 20000);

-- 最近一次成功抓取到段位的时间；NULL 表示从未抓到（多半是没开公开数据）
ALTER TABLE player_stats ADD COLUMN rank_checked_at INTEGER;
