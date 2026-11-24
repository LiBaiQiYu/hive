/**
 * `node:sqlite` 的加载垫片。
 *
 * 为什么不直接 `import { DatabaseSync } from 'node:sqlite'`：
 * Vite 5（vitest 底层）判断内置模块时用的是 Node 的 `builtinModules` 列表，
 * 而 Node 22 把 sqlite 只登记为 `node:sqlite`、**没有**裸名 `sqlite`。
 * Vite 会先剥掉 `node:` 前缀再查表，于是把 `sqlite` 当成一个 npm 包去解析，
 * 单测直接报 `Failed to load url sqlite`——运行时代码没问题，只是加载器不认。
 *
 * 这里改走 `createRequire`：绕过打包器的模块解析，让 Node 自己 `require`。
 * 类型仍然用 `node:sqlite` 的官方声明（type-only import 会被擦除，不进产物）。
 */
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncInstance, StatementSync } from 'node:sqlite';

export type { DatabaseSyncInstance, StatementSync };

const nodeRequire = createRequire(import.meta.url);

interface SqliteModule {
  DatabaseSync: new (filename: string) => DatabaseSyncInstance;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const sqlite = nodeRequire('node:sqlite') as SqliteModule;

/** 打开一个 SQLite 文件（':memory:' 也可以） */
export const DatabaseSync = sqlite.DatabaseSync;
