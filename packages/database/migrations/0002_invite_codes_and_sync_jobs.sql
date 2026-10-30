-- =============================================================================
-- HIVE V1.0 · 002 邀请码注册 + D1 任务队列（替代 Cloudflare Queues）
-- -----------------------------------------------------------------------------
-- 背景：V1.0 先跑 Workers 免费版，而 Queues 属于 Workers 付费计划。
-- 因此异步任务改为"D1 outbox + Cron 抽干"：消息落 sync_jobs 表，Cron 每分钟
-- 以租约方式抢占执行。接口契约与 Queues 的消息体保持一致，日后升级付费版
-- 只需把 drainJobs 换成 queue.send()，业务代码不动。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. 邀请码（REGISTRATION_REQUIRE_INVITE=true 时注册必须携带）
-- -----------------------------------------------------------------------------

CREATE TABLE invite_codes (
  id          TEXT    PRIMARY KEY,
  -- 规范形式：大写、6..16 位、仅 [A-Z0-9-]。展示时的分组连字符由前端补，不落库
  code        TEXT    NOT NULL CHECK (
                        length(code) BETWEEN 6 AND 16
                        AND code = upper(code)
                        AND code NOT GLOB '*[^A-Z0-9-]*'
                      ),
  label       TEXT    CHECK (label IS NULL OR length(label) <= 40),
  -- 0 表示不限次数（用于官方长期通道）
  max_uses    INTEGER NOT NULL DEFAULT 1 CHECK (max_uses >= 0),
  used_count  INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  expires_at  INTEGER,
  revoked_at  INTEGER,
  created_by  TEXT    REFERENCES users (id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  updated_at  INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  CHECK (max_uses = 0 OR used_count <= max_uses),
  CHECK (expires_at IS NULL OR expires_at > created_at)
);

CREATE UNIQUE INDEX ux_invite_codes_code ON invite_codes (code);
CREATE INDEX idx_invite_codes_created ON invite_codes (created_at DESC);

-- 注册溯源：谁邀请进来的。允许 NULL（早期账号、管理员手工创建）
ALTER TABLE users ADD COLUMN invite_code_id TEXT REFERENCES invite_codes (id) ON DELETE SET NULL;
CREATE INDEX idx_users_invite_code ON users (invite_code_id);

-- -----------------------------------------------------------------------------
-- 2. 任务 outbox（免费版替代 Queues）
-- -----------------------------------------------------------------------------

CREATE TABLE sync_jobs (
  id            TEXT    PRIMARY KEY,
  kind          TEXT    NOT NULL CHECK (kind IN ('PLAYER_SYNC', 'MATCH_IMPORT', 'RATING_RECOMPUTE')),
  -- 消息体（与 Queues 时代的消息契约一致），写入前用 Zod 校验
  payload_json  TEXT    NOT NULL,
  -- 去重键：同一玩家重复点"同步"不产生多条待执行任务
  dedupe_key    TEXT,
  status        TEXT    NOT NULL DEFAULT 'PENDING'
                CHECK (status IN ('PENDING', 'RUNNING', 'DONE', 'FAILED', 'DEAD')),
  attempts      INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts  INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  -- 退避重试：未到时间的任务不被抢占
  available_at  INTEGER NOT NULL,
  -- 租约：抢占后写 locked_until，超时未完成则被回收重试（避免 Worker 超时导致任务永久卡住）
  locked_until  INTEGER,
  last_error    TEXT,
  created_at    INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  updated_at    INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  finished_at   INTEGER,
  CHECK (status <> 'PENDING' OR locked_until IS NULL),
  CHECK (attempts <= max_attempts),
  CHECK (status NOT IN ('DONE', 'DEAD') OR finished_at IS NOT NULL)
);

-- 抢占扫描路径
CREATE INDEX idx_sync_jobs_claim ON sync_jobs (status, available_at);
-- 同一去重键最多存在一条在途任务（PENDING / RUNNING）
CREATE UNIQUE INDEX ux_sync_jobs_dedupe ON sync_jobs (dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('PENDING', 'RUNNING');
CREATE INDEX idx_sync_jobs_finished ON sync_jobs (status, finished_at DESC);
