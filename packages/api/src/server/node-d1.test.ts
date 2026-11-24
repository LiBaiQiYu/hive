import { beforeEach, describe, expect, it } from 'vitest';
import { NodeD1 } from './node-d1';

/**
 * D1 兼容层的契约测试。
 *
 * 这些断言不是在测 node:sqlite，而是在测**业务代码依赖的 D1 语义**：
 * 返回形状（`{ results, meta.changes }`）、`bind` 的不可变性、batch 的事务性。
 * 任何一条破了，后端 270 处调用里就有一批会静默出错。
 */
describe('NodeD1', () => {
  let db: NodeD1;

  beforeEach(() => {
    db = new NodeD1(':memory:');
    db.raw.exec(`
      CREATE TABLE t (
        id    TEXT PRIMARY KEY,
        name  TEXT NOT NULL,
        n     INTEGER NOT NULL DEFAULT 0
      )
    `);
  });

  it('run() 返回 meta.changes，业务代码靠它判断"改没改到"', async () => {
    const inserted = await db.prepare(`INSERT INTO t (id, name) VALUES (?, ?)`).bind('a', 'x').run();
    expect(inserted.success).toBe(true);
    expect(inserted.meta.changes).toBe(1);

    const updated = await db.prepare(`UPDATE t SET n = n + 1 WHERE id = ?`).bind('a').run();
    expect(updated.meta.changes).toBe(1);

    const missed = await db.prepare(`UPDATE t SET n = n + 1 WHERE id = ?`).bind('nope').run();
    expect(missed.meta.changes).toBe(0);
  });

  it('first() 命不中返回 null；带列名时只取那一列', async () => {
    await db.prepare(`INSERT INTO t (id, name, n) VALUES (?, ?, ?)`).bind('a', 'x', 7).run();

    const row = await db.prepare(`SELECT id, name, n FROM t WHERE id = ?`).bind('a').first<{ name: string }>();
    expect(row?.name).toBe('x');

    const column = await db.prepare(`SELECT n FROM t WHERE id = ?`).bind('a').first<number>('n');
    expect(column).toBe(7);

    const missing = await db.prepare(`SELECT * FROM t WHERE id = ?`).bind('zzz').first();
    expect(missing).toBeNull();
  });

  it('all() 返回 { results } —— 后端到处在用 results', async () => {
    await db.prepare(`INSERT INTO t (id, name) VALUES (?, ?), (?, ?)`).bind('a', 'x', 'b', 'y').run();
    const out = await db.prepare(`SELECT id FROM t ORDER BY id`).all<{ id: string }>();
    expect(out.success).toBe(true);
    expect(out.results.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('bind() 不可变：同一条语句能复用出两个不同参数', async () => {
    const base = db.prepare(`INSERT INTO t (id, name) VALUES (?, ?)`);
    await base.bind('a', 'x').run();
    await base.bind('b', 'y').run();

    const count = await db.prepare(`SELECT count(*) AS n FROM t`).first<{ n: number }>();
    expect(count?.n).toBe(2);
  });

  it('boolean 存 0/1、undefined 当 NULL（业务侧很常见的两种入参）', async () => {
    db.raw.exec('ALTER TABLE t ADD COLUMN opt INTEGER');
    await db.prepare(`INSERT INTO t (id, name, n, opt) VALUES (?, ?, ?, ?)`).bind('a', 'x', true, undefined).run();
    await db.prepare(`INSERT INTO t (id, name, n, opt) VALUES (?, ?, ?, ?)`).bind('b', 'y', false, 5).run();

    const rows = await db
      .prepare(`SELECT id, n, opt FROM t ORDER BY id`)
      .all<{ id: string; n: number; opt: number | null }>();
    expect(rows.results).toEqual([
      { id: 'a', n: 1, opt: null },
      { id: 'b', n: 0, opt: 5 },
    ]);
  });

  it('batch() 是一个事务：中途失败整批回滚', async () => {
    const unique = db.prepare(`INSERT INTO t (id, name) VALUES (?, ?)`).bind('dup', 'x');
    await unique.run();

    await expect(
      db.batch([
        db.prepare(`INSERT INTO t (id, name) VALUES (?, ?)`).bind('new', 'ok'),
        // 主键冲突：这一条会炸
        db.prepare(`INSERT INTO t (id, name) VALUES (?, ?)`).bind('dup', 'boom'),
      ]),
    ).rejects.toThrow();

    const rows = await db.prepare(`SELECT id FROM t ORDER BY id`).all<{ id: string }>();
    // 'new' 必须被回滚掉，只剩最初那一行
    expect(rows.results.map((r) => r.id)).toEqual(['dup']);
  });

  it('batch() 按顺序返回与语句一一对应的结果', async () => {
    const out = await db.batch([
      db.prepare(`INSERT INTO t (id, name) VALUES (?, ?)`).bind('a', 'x'),
      db.prepare(`INSERT INTO t (id, name) VALUES (?, ?)`).bind('b', 'y'),
      db.prepare(`UPDATE t SET n = 9 WHERE id = ?`).bind('a'),
    ]);
    expect(out).toHaveLength(3);
    expect(out.map((r) => r.meta.changes)).toEqual([1, 1, 1]);
  });

  it('外键约束默认开启（D1 也是默认开）', async () => {
    db.raw.exec(`
      CREATE TABLE parent (id TEXT PRIMARY KEY);
      CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parent(id));
    `);
    await expect(
      db.prepare(`INSERT INTO child (id, parent_id) VALUES (?, ?)`).bind('c1', 'missing').run(),
    ).rejects.toThrow();
  });

  it('空 batch 直接返回空数组，不开事务', async () => {
    await expect(db.batch([])).resolves.toEqual([]);
  });
});
