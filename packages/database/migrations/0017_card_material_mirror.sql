-- =============================================================================
-- HIVE V1.0 · 017 「镜面」材质（创始人专属）
-- -----------------------------------------------------------------------------
-- card_material 的清单里加一个 `mirror`（WebGL2 渲的镜面金属板）。
-- SQLite 改不了 CHECK，只能删列重建；和 0014 一样先备份、重建、按 id 回填，
-- **不能删了直接加**——那会把所有人的材质重置成 basic（0008 的教训）。
--
-- 列顺序的代价（重要）：
--   SQLite 的 ADD COLUMN 只能追加到表尾，所以这四列重建后从原本的
--   「invite_code_id 之后」搬到表尾（is_founder / email_confirmed_at 之后）。
--   packages/database/src/schema/users.ts 必须同步把四个字段挪到最后，
--   否则 check_parity 会报"列顺序不一致"。
--   以后再加材质，照抄这份文件即可（同样只动这四列）。
-- =============================================================================

PRAGMA defer_foreign_keys = on;

-- 1) 备份现有皮肤选择（生产上 byc1030 现在是 infinity，必须原样回来）
CREATE TABLE users_card_skin_backup AS
  SELECT id, card_material, card_frame, card_frame_color, card_frame_effect FROM users;

-- 2) 四列一起删、按原顺序加回来（材质清单多一个 mirror）
ALTER TABLE users DROP COLUMN card_material;
ALTER TABLE users DROP COLUMN card_frame;
ALTER TABLE users DROP COLUMN card_frame_color;
ALTER TABLE users DROP COLUMN card_frame_effect;

ALTER TABLE users ADD COLUMN card_material TEXT NOT NULL DEFAULT 'basic'
  CHECK (card_material IN (
    'basic', 'pixel', 'acrylic', 'sparkle', 'holo', 'gold', 'psi', 'infinity', 'mirror'
  ));

ALTER TABLE users ADD COLUMN card_frame TEXT NOT NULL DEFAULT 'hairline'
  CHECK (card_frame IN (
    'none', 'hairline', 'double', 'corners', 'bevel',
    'frost', 'spark', 'arc'
  ));

ALTER TABLE users ADD COLUMN card_frame_color TEXT NOT NULL DEFAULT 'auto'
  CHECK (card_frame_color IN (
    'auto', 'gold', 'ice', 'cyan', 'violet', 'rose', 'emerald', 'rainbow'
  ));

ALTER TABLE users ADD COLUMN card_frame_effect TEXT NOT NULL DEFAULT 'steady'
  CHECK (card_frame_effect IN ('steady', 'breathe', 'blink'));

-- 3) 回填：备份里没有的（理论上不会有）用默认值兜底
UPDATE users SET
  card_material     = COALESCE((SELECT b.card_material     FROM users_card_skin_backup b WHERE b.id = users.id), 'basic'),
  card_frame        = COALESCE((SELECT b.card_frame        FROM users_card_skin_backup b WHERE b.id = users.id), 'hairline'),
  card_frame_color  = COALESCE((SELECT b.card_frame_color  FROM users_card_skin_backup b WHERE b.id = users.id), 'auto'),
  card_frame_effect = COALESCE((SELECT b.card_frame_effect FROM users_card_skin_backup b WHERE b.id = users.id), 'steady');

DROP TABLE users_card_skin_backup;
