-- =============================================================================
-- HIVE V1.0 · 006 卡片边框清单扩充（霜线 / 电光 / 雷纹）
-- -----------------------------------------------------------------------------
-- 参考 Steam 社区物品边框的做法：透明底、只描一圈，靠辉光与粒子做质感。
-- 这里只加枚举值，不改结构；做法与 005 相同 —— SQLite 改不了 CHECK，
-- 而 users 被大量子表 ON DELETE CASCADE 引用又不能整表重建，
-- 所以直接 DROP COLUMN + 按新清单 ADD 回来（这几列没有索引/外键依赖）。
--
-- 注意 card_effect 也要一起删了再加回去：列的顺序必须保持
-- material → frame → effect，否则 check_parity 会报列顺序不一致。
-- =============================================================================

PRAGMA defer_foreign_keys = on;

ALTER TABLE users DROP COLUMN card_frame;
ALTER TABLE users DROP COLUMN card_effect;

ALTER TABLE users ADD COLUMN card_frame TEXT NOT NULL DEFAULT 'hairline'
  CHECK (card_frame IN (
    'none', 'hairline', 'double', 'corners', 'bevel',
    'frost', 'spark', 'arc'
  ));

ALTER TABLE users ADD COLUMN card_effect TEXT NOT NULL DEFAULT 'none'
  CHECK (card_effect IN ('none', 'holo', 'sparkle', 'scan', 'pulse'));
