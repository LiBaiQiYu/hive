/**
 * 迁移命令行：容器启动前跑一次（见 Dockerfile 的 CMD / deploy 脚本）。
 *
 *   node dist/migrate.mjs
 *
 * 只做一件事：把没应用过的 .sql 按序打进去，然后退出。
 * 幂等，重复跑安全。
 */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { NodeD1 } from './node-d1';
import { runMigrations } from './migrate';

const dbPath = resolve(process.env.DB_PATH?.trim() || './data/hive.db');
const migrationsDir = resolve(process.env.MIGRATIONS_DIR?.trim() || 'packages/database/migrations');

// 目录不存在时 DatabaseSync 会直接报错，先建出来（首次部署时 data/ 还没有）
mkdirSync(dirname(dbPath), { recursive: true });

const db = new NodeD1(dbPath);
try {
  const result = runMigrations(db.raw, migrationsDir);
  if (result.applied.length === 0) {
    console.log(`[migrate] 已是最新（跳过 ${result.skipped} 个）`);
  } else {
    console.log(`[migrate] 应用 ${result.applied.length} 个，跳过 ${result.skipped} 个：`);
    for (const file of result.applied) console.log(`  ✓ ${file}`);
  }
} catch (err) {
  console.error('[migrate] 失败：', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  db.close();
}
