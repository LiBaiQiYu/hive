-- =============================================================================
-- HIVE V1.0 · D1 初始 Schema
-- -----------------------------------------------------------------------------
-- 本文件是数据库结构的唯一真源（single source of truth）。
-- Drizzle Schema（packages/database/src/schema/*）只提供类型安全查询能力，
-- 结构差异（CHECK / 部分索引 / 触发器）以本文件为准。
--
-- 全局约定：
--   1. 主键：TEXT，UUIDv7 字符串（36 字符小写）。UUIDv7 具备时间序，利于 B+Tree 局部性。
--   2. 时间：INTEGER，UTC Unix 毫秒时间戳。应用层写入毫秒精度；SQL 默认值仅兜底（秒精度）。
--   3. 布尔：INTEGER 0/1，列名以 is_ 开头。
--   4. 枚举：TEXT + CHECK IN (...)。新增枚举值必须走迁移。
--   5. JSON：TEXT 序列化，列名以 _json 结尾（PRD 锁定的 *_snapshot 字段除外）。
--   6. 外键：显式声明。D1 默认执行外键约束。
--   7. 金额/评分等需要精确展示的比率使用基点（basis point, 0..10000），后缀 _bp。
--
-- 执行：pnpm db:migrate:local  /  pnpm db:migrate:remote:<env>
-- 说明：本迁移不包含任何业务数据。首个管理员由 seed 脚本显式创建。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. 身份与权限
-- -----------------------------------------------------------------------------

-- 平台账号。username / email 一律以规范化（小写）形式存储，CHECK 兜底防止脏数据。
CREATE TABLE users (
  id                TEXT    PRIMARY KEY,
  username          TEXT    NOT NULL CHECK (length(username) BETWEEN 3 AND 24 AND username = lower(username)),
  display_name      TEXT    NOT NULL CHECK (length(display_name) BETWEEN 1 AND 32),
  email             TEXT    NOT NULL CHECK (email = lower(email)),
  -- 格式：pbkdf2_sha256$<iterations>$<salt_b64>$<hash_b64>，便于迭代次数升级与算法迁移
  password_hash     TEXT    NOT NULL,
  role              TEXT    NOT NULL DEFAULT 'PLAYER' CHECK (role IN ('PLAYER', 'ADMIN')),
  status            TEXT    NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED', 'DELETED')),
  -- 社群身份：QQ 群内的可识别标识，可选
  qq_number         TEXT    CHECK (qq_number IS NULL OR (length(qq_number) BETWEEN 5 AND 12 AND qq_number NOT GLOB '*[^0-9]*')),
  avatar_url        TEXT,
  bio               TEXT    CHECK (bio IS NULL OR length(bio) <= 280),
  -- 登录风控：连续失败计数 + 锁定截止时间，避免为限流单独引入 KV
  failed_login_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  locked_until      INTEGER,
  last_login_at     INTEGER,
  created_at        INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  updated_at        INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000)
);

CREATE UNIQUE INDEX ux_users_username ON users (username);
CREATE UNIQUE INDEX ux_users_email ON users (email);
-- 部分唯一索引：仅对填写了 QQ 的用户生效，允许大量 NULL
CREATE UNIQUE INDEX ux_users_qq_number ON users (qq_number) WHERE qq_number IS NOT NULL;

-- 会话。id 存储 sha256(token) 十六进制，数据库泄露不等于会话泄露。
CREATE TABLE sessions (
  id            TEXT    PRIMARY KEY,
  user_id       TEXT    NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  user_agent    TEXT    CHECK (user_agent IS NULL OR length(user_agent) <= 256),
  -- 隐私：不存原始 IP，只存 sha256(ip + 每日轮换盐)
  ip_hash       TEXT,
  revoked_at    INTEGER,
  CHECK (expires_at > created_at)
);

CREATE INDEX idx_sessions_user_id ON sessions (user_id);
CREATE INDEX idx_sessions_expires_at ON sessions (expires_at);

-- 第三方游戏账号。V1.0 仅 Steam，且一个 HIVE 账号只能绑定一个 Steam。
CREATE TABLE game_accounts (
  id               TEXT    PRIMARY KEY,
  user_id          TEXT    NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider         TEXT    NOT NULL DEFAULT 'STEAM' CHECK (provider IN ('STEAM')),
  -- SteamID64：17 位纯数字。禁止 GLOB 出现非数字字符
  steam_id64       TEXT    NOT NULL CHECK (length(steam_id64) = 17 AND steam_id64 NOT GLOB '*[^0-9]*'),
  -- DOTA2 account_id = steam_id64 - 76561197960265728
  dota_account_id  INTEGER CHECK (dota_account_id IS NULL OR dota_account_id > 0),
  persona_name     TEXT,
  avatar_url       TEXT,
  profile_url      TEXT,
  is_primary       INTEGER NOT NULL DEFAULT 1 CHECK (is_primary IN (0, 1)),
  -- 只有通过 Steam OpenID 服务端校验后才写入，故必填
  verified_at      INTEGER NOT NULL,
  last_synced_at   INTEGER,
  created_at       INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  updated_at       INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000)
);

CREATE UNIQUE INDEX ux_game_accounts_steam_id64 ON game_accounts (steam_id64);
-- 同一用户同一 provider 只允许一个绑定记录（换绑走 UPDATE，不新增行）
CREATE UNIQUE INDEX ux_game_accounts_user_provider ON game_accounts (user_id, provider);

-- -----------------------------------------------------------------------------
-- 2. 玩家档案与外部数据
-- -----------------------------------------------------------------------------

-- 玩家 DOTA2 外部数据快照（每个用户一行，保存最近一次同步结果）
CREATE TABLE player_stats (
  id                  TEXT    PRIMARY KEY,
  user_id             TEXT    NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  game_account_id     TEXT    REFERENCES game_accounts (id) ON DELETE SET NULL,
  -- rank_tier 采用 DOTA2 原始编码：十位=勋章(1..8)，个位=星级(0..5)，如 31 = 传奇 1 星
  rank_tier           INTEGER CHECK (rank_tier IS NULL OR rank_tier BETWEEN 0 AND 85),
  leaderboard_rank    INTEGER CHECK (leaderboard_rank IS NULL OR leaderboard_rank > 0),
  career_matches      INTEGER NOT NULL DEFAULT 0 CHECK (career_matches >= 0),
  career_wins         INTEGER NOT NULL DEFAULT 0 CHECK (career_wins >= 0),
  recent_matches      INTEGER NOT NULL DEFAULT 0 CHECK (recent_matches >= 0),
  recent_wins         INTEGER NOT NULL DEFAULT 0 CHECK (recent_wins >= 0),
  avg_kills           REAL    NOT NULL DEFAULT 0,
  avg_deaths          REAL    NOT NULL DEFAULT 0,
  avg_assists         REAL    NOT NULL DEFAULT 0,
  avg_gpm             REAL    NOT NULL DEFAULT 0,
  avg_xpm             REAL    NOT NULL DEFAULT 0,
  source              TEXT    NOT NULL DEFAULT 'OPENDOTA' CHECK (source IN ('OPENDOTA', 'STRATZ', 'MANUAL')),
  -- 评分输入快照（段位分、近况分、位置分、英雄池分、社区分），用于解释"为什么是 720"
  algorithm_inputs_json TEXT,
  fetched_at          INTEGER,
  sync_state          TEXT    NOT NULL DEFAULT 'IDLE' CHECK (sync_state IN ('IDLE', 'QUEUED', 'SYNCING', 'ERROR')),
  sync_error          TEXT,
  created_at          INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  updated_at          INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  CHECK (career_wins <= career_matches),
  CHECK (recent_wins <= recent_matches)
);

CREATE UNIQUE INDEX ux_player_stats_user_id ON player_stats (user_id);

CREATE TABLE player_heroes (
  id              TEXT    PRIMARY KEY,
  user_id         TEXT    NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  hero_id         INTEGER NOT NULL CHECK (hero_id BETWEEN 1 AND 200),
  matches_played  INTEGER NOT NULL DEFAULT 0 CHECK (matches_played >= 0),
  wins            INTEGER NOT NULL DEFAULT 0 CHECK (wins >= 0),
  avg_gpm         REAL,
  avg_xpm         REAL,
  avg_net_worth   REAL,
  last_played_at  INTEGER,
  updated_at      INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  CHECK (wins <= matches_played)
);

CREATE UNIQUE INDEX ux_player_heroes_user_hero ON player_heroes (user_id, hero_id);

-- 位置偏好：1=优势路核心(1号位) .. 5=辅助(5号位)
CREATE TABLE player_positions (
  id              TEXT    PRIMARY KEY,
  user_id         TEXT    NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  position        INTEGER NOT NULL CHECK (position BETWEEN 1 AND 5),
  preference_rank INTEGER NOT NULL CHECK (preference_rank BETWEEN 1 AND 5),
  proficiency     INTEGER NOT NULL DEFAULT 50 CHECK (proficiency BETWEEN 0 AND 100),
  updated_at      INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000)
);

CREATE UNIQUE INDEX ux_player_positions_user_position ON player_positions (user_id, position);
-- 同一用户不能有两个"第 N 志愿"
CREATE UNIQUE INDEX ux_player_positions_user_rank ON player_positions (user_id, preference_rank);

-- -----------------------------------------------------------------------------
-- 3. 赛事与报名
-- -----------------------------------------------------------------------------

-- events = 一次社区活动；matches = 活动内的具体比赛场次
CREATE TABLE events (
  id                    TEXT    PRIMARY KEY,
  title                 TEXT    NOT NULL CHECK (length(title) BETWEEN 1 AND 64),
  summary               TEXT,
  rules_markdown        TEXT,
  format                TEXT    NOT NULL DEFAULT 'DOTA2_5V5' CHECK (format IN ('DOTA2_5V5')),
  team_size             INTEGER NOT NULL DEFAULT 5 CHECK (team_size = 5),
  -- 容量必须是"一场比赛人数"（10）的整数倍：不足 10 人的部分进入候补，不创建残缺比赛
  capacity              INTEGER NOT NULL DEFAULT 20 CHECK (capacity > 0 AND capacity % 10 = 0),
  status                TEXT    NOT NULL DEFAULT 'DRAFT'
                        CHECK (status IN ('DRAFT', 'REGISTRATION_OPEN', 'REGISTRATION_CLOSED',
                                          'PUBLISHED', 'COMPLETED', 'ARCHIVED', 'CANCELLED')),
  registration_opens_at INTEGER,
  registration_closes_at INTEGER,
  starts_at             INTEGER,
  ends_at               INTEGER,
  created_by            TEXT    NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at            INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  updated_at            INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  CHECK (registration_closes_at IS NULL OR registration_opens_at IS NULL
         OR registration_closes_at > registration_opens_at)
);

CREATE INDEX idx_events_status_starts ON events (status, starts_at);

CREATE TABLE registrations (
  id                          TEXT    PRIMARY KEY,
  event_id                    TEXT    NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  user_id                     TEXT    NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  status                      TEXT    NOT NULL DEFAULT 'CONFIRMED'
                              CHECK (status IN ('CONFIRMED', 'WAITLIST', 'WITHDRAWN', 'CANCELLED', 'REJECTED')),
  position_preference         INTEGER CHECK (position_preference BETWEEN 1 AND 5),
  secondary_position          INTEGER CHECK (secondary_position BETWEEN 1 AND 5),
  -- 报名瞬间的实力评分快照：后续管理员修正评分不得回写这里
  system_rating_snapshot      INTEGER NOT NULL CHECK (system_rating_snapshot BETWEEN 0 AND 1000),
  admin_adjustment_snapshot   INTEGER NOT NULL,
  effective_rating_snapshot   INTEGER NOT NULL CHECK (effective_rating_snapshot BETWEEN 0 AND 1000),
  -- JSON 数组，报名时的完整位置偏好（含熟练度），如 [{"position":2,"rank":1,"proficiency":80}]
  position_snapshot           TEXT,
  snapshot_at                 INTEGER NOT NULL,
  waitlist_position           INTEGER CHECK (waitlist_position IS NULL OR waitlist_position > 0),
  note                        TEXT CHECK (note IS NULL OR length(note) <= 140),
  created_at                  INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  updated_at                  INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  withdrawn_at                INTEGER,
  CHECK (secondary_position IS NULL OR position_preference IS NULL
         OR secondary_position <> position_preference),
  CHECK (status <> 'WAITLIST' OR waitlist_position IS NOT NULL)
);

-- 防止重复报名（退赛后重新报名复用同一行，通过 status 流转）
CREATE UNIQUE INDEX ux_registrations_event_user ON registrations (event_id, user_id);
CREATE INDEX idx_registrations_event_status ON registrations (event_id, status, effective_rating_snapshot DESC);
CREATE INDEX idx_registrations_user ON registrations (user_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- 4. 实力评分（系统评分 + 管理员修正 + 最终评分）
-- -----------------------------------------------------------------------------

-- 每个用户一行，保存当前生效的三层评分。effective_rating 由应用层统一计算后写入（冗余以支持排序）。
CREATE TABLE player_ratings (
  id                TEXT    PRIMARY KEY,
  user_id           TEXT    NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  system_rating     INTEGER NOT NULL DEFAULT 500 CHECK (system_rating BETWEEN 0 AND 1000),
  -- 业务上限由服务端常量 ADMIN_ADJUSTMENT_LIMIT 控制（默认 ±150）；
  -- 数据库只做防越界保护，便于后续在后台调整业务上限而不改表结构
  admin_adjustment  INTEGER NOT NULL DEFAULT 0 CHECK (admin_adjustment BETWEEN -500 AND 500),
  effective_rating  INTEGER NOT NULL DEFAULT 500 CHECK (effective_rating BETWEEN 0 AND 1000),
  -- 数据置信度（基点）：样本越少越接近 0，用于向 500 收缩
  confidence_bp     INTEGER NOT NULL DEFAULT 0 CHECK (confidence_bp BETWEEN 0 AND 10000),
  breakdown_json    TEXT,
  algorithm_version TEXT    NOT NULL DEFAULT 'warroom-v1',
  computed_at       INTEGER,
  adjusted_by       TEXT    REFERENCES users (id) ON DELETE SET NULL,
  adjusted_at       INTEGER,
  updated_at        INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  -- 最终评分必须等于 clamp(系统评分 + 修正, 0, 1000)
  CHECK (effective_rating = max(0, min(1000, system_rating + admin_adjustment)))
);

CREATE UNIQUE INDEX ux_player_ratings_user_id ON player_ratings (user_id);
-- 排行榜：最终评分倒序
CREATE INDEX idx_player_ratings_effective ON player_ratings (effective_rating DESC);

-- 管理员修正历史（append-only，永不更新、永不删除）
CREATE TABLE rating_adjustments (
  id              TEXT    PRIMARY KEY,
  user_id         TEXT    NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  operator_id     TEXT    NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  old_adjustment  INTEGER NOT NULL,
  new_adjustment  INTEGER NOT NULL,
  old_effective   INTEGER NOT NULL,
  new_effective   INTEGER NOT NULL,
  reason          TEXT    NOT NULL CHECK (length(trim(reason)) BETWEEN 4 AND 200),
  -- 可选：该修正发生在哪次赛事组织期间
  event_id        TEXT    REFERENCES events (id) ON DELETE SET NULL,
  created_at      INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  CHECK (old_adjustment <> new_adjustment)
);

CREATE INDEX idx_rating_adjustments_user ON rating_adjustments (user_id, created_at DESC);
CREATE INDEX idx_rating_adjustments_operator ON rating_adjustments (operator_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- 5. 比赛、队伍与阵容
-- -----------------------------------------------------------------------------

CREATE TABLE matches (
  id                     TEXT    PRIMARY KEY,
  event_id               TEXT    NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  match_no               INTEGER NOT NULL CHECK (match_no > 0),
  title                  TEXT,
  status                 TEXT    NOT NULL DEFAULT 'DRAFT'
                         CHECK (status IN ('DRAFT', 'PUBLISHED', 'IN_PROGRESS', 'COMPLETED', 'VOID')),
  scheduled_at           INTEGER,
  published_at           INTEGER,
  completed_at           INTEGER,
  -- DOTA2 match_id 已超出 32 位，必须用 TEXT
  dota_match_id          TEXT    CHECK (dota_match_id IS NULL OR dota_match_id NOT GLOB '*[^0-9]*'),
  radiant_win            INTEGER CHECK (radiant_win IS NULL OR radiant_win IN (0, 1)),
  duration_seconds       INTEGER CHECK (duration_seconds IS NULL OR duration_seconds > 0),
  -- 发布时刻两队总评分差（绝对值），用于赛后回看"这局是否均衡"
  rating_gap             INTEGER CHECK (rating_gap IS NULL OR rating_gap >= 0),
  generation_algo_version TEXT,
  generation_seed        INTEGER,
  -- 乐观锁：分组编辑器并发保存与发布校验
  version                INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by             TEXT    NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at             INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  updated_at             INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  CHECK (status <> 'PUBLISHED' OR published_at IS NOT NULL),
  CHECK (status <> 'COMPLETED' OR (completed_at IS NOT NULL AND radiant_win IS NOT NULL))
);

CREATE UNIQUE INDEX ux_matches_event_match_no ON matches (event_id, match_no);
CREATE UNIQUE INDEX ux_matches_dota_match_id ON matches (dota_match_id) WHERE dota_match_id IS NOT NULL;
CREATE INDEX idx_matches_event_status ON matches (event_id, status);

CREATE TABLE teams (
  id                     TEXT    PRIMARY KEY,
  match_id               TEXT    NOT NULL REFERENCES matches (id) ON DELETE CASCADE,
  -- 冗余 event_id：赛事阵容列表页避免 join matches
  event_id               TEXT    NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  side                   TEXT    NOT NULL CHECK (side IN ('RADIANT', 'DIRE')),
  name                   TEXT    NOT NULL,
  total_rating           INTEGER NOT NULL DEFAULT 0,
  average_rating         INTEGER NOT NULL DEFAULT 0,
  -- 5 个位置是否被完整覆盖（基点 10000 = 全部覆盖）
  position_coverage_bp   INTEGER NOT NULL DEFAULT 0 CHECK (position_coverage_bp BETWEEN 0 AND 10000),
  created_at             INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  updated_at             INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000)
);

CREATE UNIQUE INDEX ux_teams_match_side ON teams (match_id, side);
CREATE INDEX idx_teams_event ON teams (event_id);

CREATE TABLE team_members (
  id                        TEXT    PRIMARY KEY,
  team_id                   TEXT    NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  -- 冗余 match_id：一处约束即可保证"一个玩家在同一场比赛中只出现一次"
  match_id                  TEXT    NOT NULL REFERENCES matches (id) ON DELETE CASCADE,
  user_id                   TEXT    NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  team_side                 TEXT    NOT NULL CHECK (team_side IN ('RADIANT', 'DIRE')),
  assigned_position         INTEGER NOT NULL CHECK (assigned_position BETWEEN 1 AND 5),
  -- 该玩家分配到当前位置的契合度（0..100），由分组算法写入，供编辑器提示"位置冲突"
  position_fit_score        INTEGER NOT NULL DEFAULT 100 CHECK (position_fit_score BETWEEN 0 AND 100),
  system_rating_snapshot    INTEGER NOT NULL CHECK (system_rating_snapshot BETWEEN 0 AND 1000),
  admin_adjustment_snapshot INTEGER NOT NULL,
  effective_rating_snapshot INTEGER NOT NULL CHECK (effective_rating_snapshot BETWEEN 0 AND 1000),
  -- 候补不占用 5 个正选位，故不受 position 唯一性约束
  is_substitute             INTEGER NOT NULL DEFAULT 0 CHECK (is_substitute IN (0, 1)),
  created_at                INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000)
);

CREATE UNIQUE INDEX ux_team_members_team_user ON team_members (team_id, user_id);
-- 关键不变量：同一场比赛，一个玩家最多出现在一个非候补阵容中
CREATE UNIQUE INDEX ux_team_members_match_user_active ON team_members (match_id, user_id) WHERE is_substitute = 0;
-- 关键不变量：同一支队伍，一个位置只能站一个人（候补除外）
CREATE UNIQUE INDEX ux_team_members_team_position ON team_members (team_id, assigned_position) WHERE is_substitute = 0;
CREATE INDEX idx_team_members_match ON team_members (match_id);
CREATE INDEX idx_team_members_user ON team_members (user_id, match_id);

-- 比赛个人数据（P1：Match ID 导入后由后台任务写入）
CREATE TABLE match_player_stats (
  id             TEXT    PRIMARY KEY,
  match_id       TEXT    NOT NULL REFERENCES matches (id) ON DELETE CASCADE,
  user_id        TEXT    NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  team_side      TEXT    NOT NULL CHECK (team_side IN ('RADIANT', 'DIRE')),
  position       INTEGER NOT NULL CHECK (position BETWEEN 1 AND 5),
  hero_id        INTEGER NOT NULL CHECK (hero_id BETWEEN 1 AND 200),
  is_win         INTEGER NOT NULL CHECK (is_win IN (0, 1)),
  kills          INTEGER NOT NULL DEFAULT 0 CHECK (kills >= 0),
  deaths         INTEGER NOT NULL DEFAULT 0 CHECK (deaths >= 0),
  assists        INTEGER NOT NULL DEFAULT 0 CHECK (assists >= 0),
  net_worth      INTEGER NOT NULL DEFAULT 0,
  gpm            INTEGER NOT NULL DEFAULT 0,
  xpm            INTEGER NOT NULL DEFAULT 0,
  last_hits      INTEGER NOT NULL DEFAULT 0,
  denies         INTEGER NOT NULL DEFAULT 0,
  hero_damage    INTEGER NOT NULL DEFAULT 0,
  tower_damage   INTEGER NOT NULL DEFAULT 0,
  hero_healing   INTEGER NOT NULL DEFAULT 0,
  items_json     TEXT,
  created_at     INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000)
);

CREATE UNIQUE INDEX ux_match_player_stats_match_user ON match_player_stats (match_id, user_id);
CREATE INDEX idx_match_player_stats_user ON match_player_stats (user_id);

-- -----------------------------------------------------------------------------
-- 6. 固定队友（P2，V1.0 仅落表结构，不参与分组算法）
-- -----------------------------------------------------------------------------

CREATE TABLE parties (
  id          TEXT    PRIMARY KEY,
  event_id    TEXT    REFERENCES events (id) ON DELETE CASCADE,
  name        TEXT    NOT NULL CHECK (length(name) BETWEEN 1 AND 32),
  created_by  TEXT    NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  status      TEXT    NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISBANDED')),
  created_at  INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  updated_at  INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000)
);

CREATE INDEX idx_parties_event ON parties (event_id);

CREATE TABLE party_members (
  id         TEXT    PRIMARY KEY,
  party_id   TEXT    NOT NULL REFERENCES parties (id) ON DELETE CASCADE,
  user_id    TEXT    NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  joined_at  INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000)
);

CREATE UNIQUE INDEX ux_party_members_party_user ON party_members (party_id, user_id);
CREATE INDEX idx_party_members_user ON party_members (user_id);

-- -----------------------------------------------------------------------------
-- 7. 审计
-- -----------------------------------------------------------------------------

-- 管理员关键操作的不可变流水。业务表只存"当前状态"，历史一律查这里。
CREATE TABLE audit_logs (
  id           TEXT    PRIMARY KEY,
  actor_id     TEXT    REFERENCES users (id) ON DELETE SET NULL,
  actor_role   TEXT    CHECK (actor_role IS NULL OR actor_role IN ('PLAYER', 'ADMIN', 'SYSTEM')),
  -- 形如 rating.adjust / event.publish / lineup.update
  action       TEXT    NOT NULL,
  entity_type  TEXT    NOT NULL,
  entity_id    TEXT,
  before_json  TEXT,
  after_json   TEXT,
  reason       TEXT,
  request_id   TEXT,
  ip_hash      TEXT,
  created_at   INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000)
);

CREATE INDEX idx_audit_logs_entity ON audit_logs (entity_type, entity_id, created_at DESC);
CREATE INDEX idx_audit_logs_actor ON audit_logs (actor_id, created_at DESC);
CREATE INDEX idx_audit_logs_created ON audit_logs (created_at DESC);
