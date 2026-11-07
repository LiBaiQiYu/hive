-- =============================================================================
-- HIVE · 0016 替补与临时参赛
-- -----------------------------------------------------------------------------
-- 场景：阵容发布后，正选里有人来不了；需要把他换下去，从「候补/已报名但没进阵容」
-- 的人里挑一个补位。也可能来了个完全没报名的朋友，临时上场，只需要记个名字。
--
-- 做法：
--   1. team_members.user_id 允许为空，并新增 guest_name / guest_mmr / is_guest：
--      临时参赛的人没有账号，阵容里也要占一个位置、记录快照评分。
--   2. 新增 match_substitutions 记录每一笔换人（下场的谁、上场的谁、哪个位置、谁操作的）。
--
-- SQLite 改不了列约束，team_members 只能重建（用户表被引用不能动，重建的是队成员表）。
-- 迁移是有损顺序的：先建新表 → 拷数据 → 删旧表 → 改名 → 重建索引。
-- =============================================================================

PRAGMA defer_foreign_keys = on;

CREATE TABLE team_members_v2 (
  id                        TEXT    PRIMARY KEY,
  team_id                   TEXT    NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  match_id                  TEXT    NOT NULL REFERENCES matches (id) ON DELETE CASCADE,
  -- 报名玩家；临时参赛（未报名）时为 NULL，姓名写在 guest_name
  user_id                   TEXT    REFERENCES users (id) ON DELETE RESTRICT,
  guest_name                TEXT    CHECK (guest_name IS NULL OR length(guest_name) BETWEEN 1 AND 32),
  guest_mmr                 INTEGER CHECK (guest_mmr IS NULL OR guest_mmr BETWEEN 0 AND 20000),
  team_side                 TEXT    NOT NULL CHECK (team_side IN ('RADIANT', 'DIRE')),
  assigned_position         INTEGER NOT NULL CHECK (assigned_position BETWEEN 1 AND 5),
  position_fit_score        INTEGER NOT NULL DEFAULT 100 CHECK (position_fit_score BETWEEN 0 AND 100),
  system_rating_snapshot    INTEGER NOT NULL CHECK (system_rating_snapshot BETWEEN 0 AND 1000),
  admin_adjustment_snapshot INTEGER NOT NULL,
  effective_rating_snapshot INTEGER NOT NULL CHECK (effective_rating_snapshot BETWEEN 0 AND 1000),
  is_substitute             INTEGER NOT NULL DEFAULT 0 CHECK (is_substitute IN (0, 1)),
  is_guest                  INTEGER NOT NULL DEFAULT 0 CHECK (is_guest IN (0, 1)),
  created_at                INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  -- 有账号的人没有 guest 字段；临时参赛的人必须没有 user_id 且必须有名字
  CHECK (
    (is_guest = 0 AND user_id IS NOT NULL AND guest_name IS NULL AND guest_mmr IS NULL)
    OR
    (is_guest = 1 AND user_id IS NULL AND guest_name IS NOT NULL)
  )
);

INSERT INTO team_members_v2 (
  id, team_id, match_id, user_id, guest_name, guest_mmr, team_side, assigned_position,
  position_fit_score, system_rating_snapshot, admin_adjustment_snapshot,
  effective_rating_snapshot, is_substitute, is_guest, created_at
)
SELECT
  id, team_id, match_id, user_id, NULL, NULL, team_side, assigned_position,
  position_fit_score, system_rating_snapshot, admin_adjustment_snapshot,
  effective_rating_snapshot, is_substitute, 0, created_at
FROM team_members;

DROP TABLE team_members;
ALTER TABLE team_members_v2 RENAME TO team_members;

CREATE UNIQUE INDEX ux_team_members_team_user ON team_members (team_id, user_id);
-- 同一场比赛，一个玩家最多出现在一个非候补阵容里（临时参赛 user_id 为 NULL，不受影响）
CREATE UNIQUE INDEX ux_team_members_match_user_active ON team_members (match_id, user_id)
  WHERE is_substitute = 0;
-- 一支队伍的一个位置只能站一个人（候补除外）
CREATE UNIQUE INDEX ux_team_members_team_position ON team_members (team_id, assigned_position)
  WHERE is_substitute = 0;
CREATE INDEX idx_team_members_match ON team_members (match_id);
CREATE INDEX idx_team_members_user ON team_members (user_id, match_id);

-- 换人流水：不作为外键约束到 team_members（重新生成阵容会整批删掉那一行）
CREATE TABLE match_substitutions (
  id                TEXT    PRIMARY KEY,
  match_id          TEXT    NOT NULL REFERENCES matches (id) ON DELETE CASCADE,
  team_id           TEXT    NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  out_member_id     TEXT    NOT NULL,
  out_user_id       TEXT    REFERENCES users (id) ON DELETE SET NULL,
  out_name          TEXT    NOT NULL,
  in_member_id      TEXT    NOT NULL,
  in_user_id        TEXT    REFERENCES users (id) ON DELETE SET NULL,
  in_name           TEXT    NOT NULL,
  in_is_guest       INTEGER NOT NULL DEFAULT 0 CHECK (in_is_guest IN (0, 1)),
  team_side         TEXT    NOT NULL CHECK (team_side IN ('RADIANT', 'DIRE')),
  assigned_position INTEGER NOT NULL CHECK (assigned_position BETWEEN 1 AND 5),
  -- ABSENT = 正选没来；MANUAL = 管理员主动调整
  reason            TEXT    NOT NULL DEFAULT 'ABSENT' CHECK (reason IN ('ABSENT', 'MANUAL')),
  note              TEXT    CHECK (note IS NULL OR length(note) <= 200),
  created_by        TEXT    NOT NULL REFERENCES users (id),
  created_at        INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000)
);

CREATE INDEX idx_match_substitutions_match ON match_substitutions (match_id);
CREATE INDEX idx_match_substitutions_out_user ON match_substitutions (out_user_id);
