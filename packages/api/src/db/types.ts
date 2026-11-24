/**
 * D1 的**类型契约**（不含任何运行时实现）。
 *
 * 为什么单独放一个文件：Node 侧的实现要 `import 'node:sqlite'`，
 * 而主 tsconfig 用的是 Workers 的类型环境，两者不能混在一个文件里。
 * 这里只写接口，Workers（D1Database 结构兼容）与 Node（node:sqlite 实现）
 * 各管各的实现，业务代码只依赖这份契约。
 */

export interface D1Meta {
  changes: number;
  last_row_id: number;
  duration: number;
}

export interface D1Result<T> {
  success: true;
  meta: D1Meta;
  results: T[];
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result<unknown>>;
}

export interface D1LikeDatabase {
  prepare(sql: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}
