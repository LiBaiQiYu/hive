-- =============================================================================
-- HIVE V1.0 · 013 密码重置令牌（邮件自助找回）
-- -----------------------------------------------------------------------------
-- Workers 免费版不能向任意邮箱发信，但 Email Routing 收信免费且不限量，
-- 所以找回流程反过来走：玩家用注册邮箱发信到 reset@ 域名 → Worker 收到后
-- 用 message.reply() 回一封带一次性链接的邮件。
--
-- 设计取舍：
--   · 只存 sha256(token)：数据库被看到也拿不到能用的令牌。
--   · 一次性 + 30 分钟过期：used_at 一旦写入就不能再用，过期行留给每日维护清理。
--   · 同一用户重新申请会作废旧令牌，避免"链接满天飞、不知道哪个能用"。
--   · 令牌明文只出现在回复邮件里，不写日志、不进审计。
-- =============================================================================

CREATE TABLE password_resets (
  id          TEXT    PRIMARY KEY,
  user_id     TEXT    NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- sha256(token) 的 base64url；明文 token 只存在于邮件中
  token_hash  TEXT    NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER,
  created_at  INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000)
);

CREATE UNIQUE INDEX ux_password_resets_token ON password_resets (token_hash);
CREATE INDEX idx_password_resets_user ON password_resets (user_id, created_at DESC);
CREATE INDEX idx_password_resets_expiry ON password_resets (expires_at);
