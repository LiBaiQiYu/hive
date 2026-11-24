/**
 * 数据库迁移：把 `packages/database/migrations/*.sql` 按序应用到 SQLite 文件。
 *
 * 与 `wrangler d1 migrations apply` 的差异：
 *   · wrangler 用 `d1_migrations` 表记录已应用的文件名；
 *   · 这里用同名表、同名结构（`name` / `applied_at`），所以两边的"已到第几号"
 *     语义一致，将来想切回 D1 也不会错乱。
 *
 * 幂等：重复执行只跑没应用过的那些。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

const MIGRATIONS_TABLE = 'd1_migrations';

interface MigrationRow {
  name: string;
}

/** 与 wrangler 建的表保持一致的列，便于对齐语义 */
function ensureTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

export interface MigrateResult {
  applied: string[];
  skipped: number;
}

export function runMigrations(db: DatabaseSync, migrationsDir: string): MigrateResult {
  ensureTable(db);

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b));

  const done = new Set(
    (db.prepare(`SELECT name FROM ${MIGRATIONS_TABLE}`).all() as unknown as MigrationRow[]).map((r) => r.name),
  );

  const insert = db.prepare(`INSERT INTO ${MIGRATIONS_TABLE} (name) VALUES (?)`);
  const applied: string[] = [];
  let skipped = 0;

  for (const file of files) {
    if (done.has(file)) {
      skipped += 1;
      continue;
    }

    const sql = readFileSync(join(migrationsDir, file), 'utf8');

    // 每个迁移单独一个事务：失败就停在那个文件上，不会留下"半套表结构"。
    // 迁移里有 `PRAGMA defer_foreign_keys = on`，它在事务内生效、提交后自动复位，
    // 所以重建表的迁移（0003/0005/…）在 SQLite 上行为与 D1 一致。
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(sql);
      insert.run(file);
      db.exec('COMMIT');
      applied.push(file);
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // 回滚失败时保留原始错误
      }
      throw new Error(`迁移 ${file} 失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { applied, skipped };
}
