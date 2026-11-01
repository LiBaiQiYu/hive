-- =============================================================================
-- HIVE V1.0 · 008 新增「灵能」材质（破碎色散）
-- -----------------------------------------------------------------------------
-- 做法与 005/006 相同：SQLite 改不了 CHECK，users 又被大量子表 CASCADE 引用，
-- 只能 DROP COLUMN 再按新清单加回来。
--
-- 注意必须把 card_frame 也一起删了再加：列顺序要保持 material → frame，
-- 否则 check_parity 会报列顺序不一致（006 已经踩过一次）。
-- =============================================================================

PRAGMA defer_foreign_keys = on;

ALTER TABLE users DROP COLUMN card_material;
ALTER TABLE users DROP COLUMN card_frame;

ALTER TABLE users ADD COLUMN card_material TEXT NOT NULL DEFAULT 'basic'
  CHECK (card_material IN (
    'basic', 'pixel', 'acrylic', 'sparkle', 'holo', 'gold', 'psi'
  ));

ALTER TABLE users ADD COLUMN card_frame TEXT NOT NULL DEFAULT 'hairline'
  CHECK (card_frame IN (
    'none', 'hairline', 'double', 'corners', 'bevel',
    'frost', 'spark', 'arc'
  ));
