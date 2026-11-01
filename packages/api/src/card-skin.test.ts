/**
 * 皮肤清单的"单一真源"守门人。
 *
 * SQL 的 CHECK 是运行时唯一的真源，@hive/shared 的类型只是它的影子。
 * 两边一旦漂移，症状是"前端能点、保存 400"或者"库里存了渲染不出来的值"，
 * 而且只在真人点击时才暴露 —— 所以在这里直接读迁移文件比一比。
 */
import { describe, expect, it } from 'vitest';
import { CARD_FRAMES, CARD_MATERIALS, toCardSkin } from '@hive/shared';
import SQL_0004 from '../../database/migrations/0004_card_skin.sql?raw';
import SQL_0005 from '../../database/migrations/0005_card_material_v2.sql?raw';
import SQL_0006 from '../../database/migrations/0006_card_frame_v2.sql?raw';
import SQL_0007 from '../../database/migrations/0007_drop_card_effect.sql?raw';
import SQL_0008 from '../../database/migrations/0008_card_material_psi.sql?raw';

/** 按迁移顺序扫描；后出现的 ADD COLUMN 覆盖先前的（0005 重写了整份材质清单） */
const MIGRATIONS = [SQL_0004, SQL_0005, SQL_0006, SQL_0007, SQL_0008];

function sqlList(column: string): string[] {
  const pattern = new RegExp(
    `ADD COLUMN\\s+${column}\\s+TEXT[^;]*?CHECK\\s*\\(\\s*${column}\\s+IN\\s*\\(([^)]*)\\)`,
    's',
  );
  let list: string[] | null = null;
  for (const sql of MIGRATIONS) {
    const match = sql.match(pattern);
    if (match?.[1]) list = [...match[1].matchAll(/'([^']+)'/g)].map((item) => item[1] as string);
  }
  if (!list) throw new Error(`迁移里找不到 ${column} 的 CHECK 清单`);
  return list;
}

describe('卡片皮肤清单', () => {
  it('材质与迁移里的 CHECK 一致', () => {
    expect(sqlList('card_material')).toEqual([...CARD_MATERIALS]);
  });

  it('边框与迁移里的 CHECK 一致', () => {
    expect(sqlList('card_frame')).toEqual([...CARD_FRAMES]);
  });

  it('特效已经整条下线（0007 删列）', () => {
    expect(SQL_0007).toContain('DROP COLUMN card_effect');
  });

  it('脏数据回落到默认皮肤而不是抛错', () => {
    expect(toCardSkin({ material: 'hologram', frame: null })).toEqual({
      material: 'basic',
      frame: 'hairline',
    });
    expect(toCardSkin({ material: 'gold', frame: 'double' })).toEqual({
      material: 'gold',
      frame: 'double',
    });
  });
});
