-- =============================================================================
-- HIVE V1.0 · 018 运行期设置（app_settings）
-- -----------------------------------------------------------------------------
-- 注册方式原来是部署级配置（wrangler.jsonc 的 REGISTRATION_REQUIRE_INVITE），
-- 想开/关一次就得改配置、重新部署。现在搬进数据库：后台「系统设置」点一下即时生效，
-- 不用发版，也不会有"本地开了、线上还关着"这种漂移。
--
-- 约定：
--   · key 用点号命名空间（如 registration.require_invite），value 一律存字符串；
--     布尔用 '1' / '0'，绕开 SQLite 没有布尔类型这件事。
--   · 可写的 key 由服务端白名单（packages/api/src/services/settings.ts）决定，
--     表本身不做校验——加一个开关就加一行，不必改 DDL。
--   · 这里只播种默认值，**默认关闭邀请制，即开放注册**（本次的产品决定）。
--     已经有行的环境不会被覆盖（ON CONFLICT DO NOTHING）。
-- =============================================================================

CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  -- 谁改的；系统播种时为 NULL。管理员删号后置空，不连坐这条记录
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000)
);

INSERT INTO app_settings (key, value) VALUES ('registration.require_invite', '0')
  ON CONFLICT (key) DO NOTHING;
