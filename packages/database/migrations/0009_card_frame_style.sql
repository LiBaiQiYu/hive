-- =============================================================================
-- HIVE V1.0 · 009 发丝线 / 双线的颜色与光效
-- -----------------------------------------------------------------------------
-- 只有 hairline（发丝线）与 double（双线）会用到这两列：
--   card_frame_color  —— 底色：跟随材质 / 六种纯色 / 流动彩色
--   card_frame_effect —— 光效：常亮 / 呼吸 / 闪烁
--
-- 其他边框（无边 / 四角 / 浮雕 / 霜线 / 电光 / 雷纹）忽略这两列，
-- 这样用户换到别的边框再换回来时，之前选的配色还在，不需要重新挑。
--
-- 两张枚举都用 CHECK 兜底；新增配色 = 新迁移改写 CHECK（SQLite 改不了旧 CHECK，
-- 只能重建列，所以清单宁短勿滥）。默认值 auto + steady 等于改造前的样子。
-- =============================================================================

ALTER TABLE users ADD COLUMN card_frame_color TEXT NOT NULL DEFAULT 'auto'
  CHECK (card_frame_color IN (
    'auto', 'gold', 'ice', 'cyan', 'violet', 'rose', 'emerald', 'rainbow'
  ));

ALTER TABLE users ADD COLUMN card_frame_effect TEXT NOT NULL DEFAULT 'steady'
  CHECK (card_frame_effect IN ('steady', 'breathe', 'blink'));
