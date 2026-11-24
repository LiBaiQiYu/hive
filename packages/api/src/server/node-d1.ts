/**
 * D1 兼容层：在自建服务器上用 Node 内置 SQLite 跑同一份后端代码。
 *
 * 为什么需要它：整个后端（28 个文件、270 处）都是按 Cloudflare D1 的
 * `env.DB.prepare().bind().first()/all()/run()` 写的。移植到 Node 时，
 * 与其把这 270 处换成另一种驱动（等于重写数据层），不如在这里实现
 * **同一套接口表面**——业务代码一行不改，两套运行时共用同一份 SQL。
 *
 * 用 node:sqlite 而不是 better-sqlite3：它是 Node 内置的，不需要
 * python/make/g++ 编译原生模块，Docker 镜像因此可以保持 slim。
 * 代价是 API 标着 experimental —— 所以 Dockerfile 里的 Node 大版本是钉死的。
 */
import type { D1LikeDatabase, D1PreparedStatement, D1Result } from '../db/types';
import { DatabaseSync } from './sqlite-driver';
import type { DatabaseSyncInstance } from './sqlite-driver';

type SqlValue = string | number | bigint | null | Uint8Array;

/**
 * node:sqlite 的绑定值只接受 string / number / bigint / null / Uint8Array。
 * 业务代码里会传 `undefined`（可选字段）与 `boolean`，这里统一规整：
 * undefined 当 NULL（与 D1 行为一致），boolean 存 0/1。
 */
function normalizeParams(values: unknown[]): SqlValue[] {
  return values.map((v) => {
    if (v === undefined || v === null) return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (v instanceof Date) return v.getTime();
    if (typeof v === 'number' || typeof v === 'string' || typeof v === 'bigint') return v;
    if (v instanceof Uint8Array) return v;
    // 其余（对象/数组）按 JSON 存，和 D1 里 TEXT 列的用法一致
    return JSON.stringify(v);
  });
}

function toNumber(v: number | bigint): number {
  return typeof v === 'bigint' ? Number(v) : v;
}

class NodePreparedStatement implements D1PreparedStatement {
  readonly #db: DatabaseSyncInstance;
  readonly #sql: string;
  readonly #params: unknown[];

  constructor(db: DatabaseSyncInstance, sql: string, params: unknown[] = []) {
    this.#db = db;
    this.#sql = sql;
    this.#params = params;
  }

  bind(...values: unknown[]): D1PreparedStatement {
    // D1 的 bind 返回新语句（不可变），这里保持同样语义
    return new NodePreparedStatement(this.#db, this.#sql, values);
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const row = this.#db.prepare(this.#sql).get(...normalizeParams(this.#params)) as
      | Record<string, unknown>
      | undefined;
    if (row === undefined) return null;
    if (column) return (row[column] ?? null) as T | null;
    return row as T;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const rows = this.#db.prepare(this.#sql).all(...normalizeParams(this.#params)) as T[];
    return { success: true, meta: { changes: 0, last_row_id: 0, duration: 0 }, results: rows };
  }

  async run(): Promise<D1Result<unknown>> {
    const info = this.#db.prepare(this.#sql).run(...normalizeParams(this.#params));
    return {
      success: true,
      meta: {
        changes: toNumber(info.changes),
        last_row_id: toNumber(info.lastInsertRowid),
        duration: 0,
      },
      results: [],
    };
  }

  /** 供 batch 复用，避免重复 prepare */
  get raw(): { sql: string; params: unknown[] } {
    return { sql: this.#sql, params: this.#params };
  }
}

export class NodeD1 implements D1LikeDatabase {
  readonly #db: DatabaseSyncInstance;
  #inTransaction = false;

  constructor(filename: string) {
    this.#db = new DatabaseSync(filename);
    // WAL：读写并发更友好，也让 `.backup` 能拿到一致快照
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec('PRAGMA foreign_keys = ON');
    // 等待锁的毫秒数；备份/迁移时可能撞上
    this.#db.exec('PRAGMA busy_timeout = 5000');
  }

  prepare(sql: string): D1PreparedStatement {
    return new NodePreparedStatement(this.#db, sql);
  }

  /**
   * D1 的 batch 是**事务**：业务代码靠它保证「分组落库 / 封盘 / 建号」的原子性。
   * 这里用 BEGIN IMMEDIATE / COMMIT / ROLLBACK 复刻同一语义。
   */
  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    if (statements.length === 0) return [];
    const out: D1Result<T>[] = [];

    // 嵌套 batch（当前业务代码没有）时直接顺序执行，避免事务嵌套报错
    const useTransaction = !this.#inTransaction;
    if (useTransaction) {
      this.#db.exec('BEGIN IMMEDIATE');
      this.#inTransaction = true;
    }

    try {
      for (const stmt of statements) {
        if (!(stmt instanceof NodePreparedStatement)) {
          throw new Error('batch 只接受本适配器创建的语句');
        }
        const info = this.#db.prepare(stmt.raw.sql).run(...normalizeParams(stmt.raw.params));
        out.push({
          success: true,
          meta: { changes: toNumber(info.changes), last_row_id: toNumber(info.lastInsertRowid), duration: 0 },
          results: [],
        });
      }
      if (useTransaction) {
        this.#db.exec('COMMIT');
        this.#inTransaction = false;
      }
      return out;
    } catch (err) {
      if (useTransaction) {
        try {
          this.#db.exec('ROLLBACK');
        } catch {
          // 回滚失败（连接已坏）时保留原始错误，别用回滚错误盖掉它
        }
        this.#inTransaction = false;
      }
      throw err;
    }
  }

  /** 迁移/备份脚本用：直接拿底层连接 */
  get raw(): DatabaseSyncInstance {
    return this.#db;
  }

  close(): void {
    this.#db.close();
  }
}
