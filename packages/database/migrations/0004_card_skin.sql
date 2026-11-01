-- =============================================================================
-- HIVE V1.0 · 004 玩家卡片外观（材质 / 边框 / 特效）
-- -----------------------------------------------------------------------------
-- 纯展示偏好：不参与评分、分队、快照，也不写审计日志——改一张卡的皮肤
-- 和换头像一样，不需要被记录。
--
-- 三个字段都是枚举，用 CHECK 兜底。前端可以随时加新皮肤，但库里只认这份清单：
-- 老版本客户端提交一个不存在的值会被直接拒绝，而不是渲染成一块空白卡。
-- 新增皮肤 = 新迁移改写 CHECK（SQLite 改 CHECK 要重建表，所以清单宁短勿滥）。
--
-- 默认值就是改造前的样子：basic + hairline + none。
-- =============================================================================

ALTER TABLE users ADD COLUMN card_material TEXT NOT NULL DEFAULT 'basic'
  CHECK (card_material IN ('basic', 'pixel', 'acrylic', 'copper', 'silver', 'gold'));

ALTER TABLE users ADD COLUMN card_frame TEXT NOT NULL DEFAULT 'hairline'
  CHECK (card_frame IN ('none', 'hairline', 'double', 'corners', 'bevel'));

ALTER TABLE users ADD COLUMN card_effect TEXT NOT NULL DEFAULT 'none'
  CHECK (card_effect IN ('none', 'holo', 'sparkle', 'scan', 'pulse'));
