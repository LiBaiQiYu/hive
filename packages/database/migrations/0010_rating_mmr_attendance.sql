-- =============================================================================
-- HIVE V1.0 · 010 实力分只看 MMR，出勤独立
-- -----------------------------------------------------------------------------
-- v3 起 system_rating = Dota2 MMR ÷ 10（0..1000），出勤不再参与实力分：
--   · 技术好但不常来的玩家不会被扣成低分，报名时按真实水平进池；
--   · 出勤只影响候补优先级（出勤高者先转正），不参与分队。
--
-- player_ratings 新增 attendance_bp（0..10000 基点，NULL = 还没有已结束赛事）：
--   · 候补排序需要按出勤快速读取，放 breakdown_json 里每次解析太别扭；
--   · 旧数据先尽量从 breakdown_json.attendanceBp 回填，保证候补顺序立刻生效；
--   · system_rating 本身需要跑一遍新算法，由每日维护 / 管理员「重算全部」完成。
-- =============================================================================

ALTER TABLE player_ratings ADD COLUMN attendance_bp INTEGER
  CHECK (attendance_bp IS NULL OR attendance_bp BETWEEN 0 AND 10000);

UPDATE player_ratings
   SET attendance_bp = CAST(json_extract(breakdown_json, '$.attendanceBp') AS INTEGER)
 WHERE breakdown_json IS NOT NULL
   AND json_valid(breakdown_json)
   AND json_extract(breakdown_json, '$.attendanceBp') IS NOT NULL
   AND json_extract(breakdown_json, '$.attendanceBp') BETWEEN 0 AND 10000;
