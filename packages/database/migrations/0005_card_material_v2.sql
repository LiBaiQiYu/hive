-- =============================================================================
-- HIVE V1.0 · 005 卡片材质清单调整（赤铜 / 白银 → 闪耀 / 全息）
-- -----------------------------------------------------------------------------
-- 背景：004 里的铜/银与"默认"辨识度不够，换成参考图上的三种质感：
--   闪耀 = 碎钻银白、全息 = 镭射菱格、金色 = 流动金箔（gold 保留，只重做质感）。
--
-- 为什么不是"重建 users 表"：SQLite 改 CHECK 的标准做法是建新表→搬数据→删旧表，
-- 但 users 被 sessions / game_accounts / registrations / player_stats … 一堆子表
-- 用 ON DELETE CASCADE 引用，DROP TABLE users 会触发隐式 DELETE，等于把这些表清空。
-- 唯一的绕法是把 foreign_keys 关掉，而它不能在事务里改——D1 的迁移是事务。
--
-- 所以这里走 ALTER TABLE ... DROP COLUMN：这三个列是 004 刚加的纯展示列，
-- 没有索引、没有外键、没有被其它表或触发器引用，删掉再按新清单加回来是安全的；
-- 代价是老用户已选的皮肤回落到默认值（本来也只影响一张卡的外观）。
-- =============================================================================

PRAGMA defer_foreign_keys = on;

ALTER TABLE users DROP COLUMN card_material;
ALTER TABLE users DROP COLUMN card_frame;
ALTER TABLE users DROP COLUMN card_effect;

ALTER TABLE users ADD COLUMN card_material TEXT NOT NULL DEFAULT 'basic'
  CHECK (card_material IN ('basic', 'pixel', 'acrylic', 'sparkle', 'holo', 'gold'));

ALTER TABLE users ADD COLUMN card_frame TEXT NOT NULL DEFAULT 'hairline'
  CHECK (card_frame IN ('none', 'hairline', 'double', 'corners', 'bevel'));

ALTER TABLE users ADD COLUMN card_effect TEXT NOT NULL DEFAULT 'none'
  CHECK (card_effect IN ('none', 'holo', 'sparkle', 'scan', 'pulse'));
