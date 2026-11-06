-- =============================================================================
-- HIVE V1.0 · 014 「无限镜」材质（创始人专属）+ 创始人标记
-- -----------------------------------------------------------------------------
-- 两件事：
--   1. card_material 的清单里加一个 `infinity`（无限镜面板）。SQLite 改不了 CHECK，
--      只能删列重建；**但这次必须保留用户已有的皮肤**——0008 当年是删了直接加，
--      等于把所有人选好的材质重置成默认值。现在先备份到临时表、重建后再按 id 回填。
--   2. users.is_founder：材质本身写在 users 上，而"只有创始人能用"不能靠前端藏按钮，
--      服务端要有可判定的身份。管理员（role=ADMIN）是会被授予/撤销的角色，
--      创始人是一次性的标记，所以单列一列，不在 role 里加值。
--
-- 列顺序必须和 packages/database/src/schema/users.ts 一致：
--   card_material → card_frame → card_frame_color → card_frame_effect → is_founder
-- 四列删了要按同样的顺序加回来，否则 check_parity 会报列顺序不一致（006 踩过）。
-- =============================================================================

PRAGMA defer_foreign_keys = on;

-- 1) 备份现有皮肤选择
CREATE TABLE users_card_skin_backup AS
  SELECT id, card_material, card_frame, card_frame_color, card_frame_effect FROM users;

-- 2) 四列一起删、按原顺序加回来（材质清单多一个 infinity）
ALTER TABLE users DROP COLUMN card_material;
ALTER TABLE users DROP COLUMN card_frame;
ALTER TABLE users DROP COLUMN card_frame_color;
ALTER TABLE users DROP COLUMN card_frame_effect;

ALTER TABLE users ADD COLUMN card_material TEXT NOT NULL DEFAULT 'basic'
  CHECK (card_material IN (
    'basic', 'pixel', 'acrylic', 'sparkle', 'holo', 'gold', 'psi', 'infinity'
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

-- 4) 创始人标记。只做身份标记，不在这里写业务规则；
--    "无限镜只有创始人能选"由 PUT /api/me/card-skin 校验。
ALTER TABLE users ADD COLUMN is_founder INTEGER NOT NULL DEFAULT 0
  CHECK (is_founder IN (0, 1));

-- 目前创始人是 byc1030（本地与生产同名）。以后换人/加人直接改这一列：
--   UPDATE users SET is_founder = 1 WHERE username = '...';
UPDATE users SET is_founder = 1 WHERE username = 'byc1030';
