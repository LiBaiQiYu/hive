-- =============================================================================
-- HIVE V1.0 · 012 玩家主页：点赞点踩 + 留言板（含回复、评论点赞）
-- -----------------------------------------------------------------------------
-- 这一版把"人"变成可访问的实体：从排行榜、战绩、赛事卡片都能点进某个玩家，
-- 看他长什么样（玩家卡）、打过哪些局，并且可以给这个人点赞/点踩、在他主页留言。
--
-- 设计取舍：
--   · 点赞点踩**一人一票、可切换、可取消**（唯一索引 actor+target），不做"多次计数"，
--     15 人社区里重复投票只会变成刷数据。
--   · 不能给自己投票（CHECK）。
--   · 留言只允许两级：parent_id 为 NULL 是一级评论，非 NULL 是回复。
--     回复"回复"在 API 层会挂到同一个根上，不做无限嵌套——
--     两级已经够用，无限嵌套在窄屏上没法排版。
--   · 评论用软删除（deleted_at）：删了还要留着位置，否则回复会变成孤儿。
--   · 评论点赞是纯计数关系表，不软删：取消点赞直接删行。
-- =============================================================================

CREATE TABLE player_reactions (
  id TEXT PRIMARY KEY,
  target_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('LIKE', 'DISLIKE')),
  created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  CHECK (target_user_id <> actor_id)
);

CREATE UNIQUE INDEX ux_player_reactions_actor ON player_reactions(actor_id, target_user_id);
CREATE INDEX idx_player_reactions_target ON player_reactions(target_user_id, kind);

CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  target_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  CHECK (length(body) BETWEEN 1 AND 1000)
);

CREATE INDEX idx_comments_target ON comments(target_user_id, parent_id, created_at);
CREATE INDEX idx_comments_parent ON comments(parent_id, created_at);

CREATE TABLE comment_likes (
  id TEXT PRIMARY KEY,
  comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000)
);

CREATE UNIQUE INDEX ux_comment_likes ON comment_likes(comment_id, user_id);
CREATE INDEX idx_comment_likes_user ON comment_likes(user_id);
