import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle Kit 只负责两件事：
 *   1. `drizzle-kit generate`：根据 schema 生成新的迁移 SQL；
 *   2. `drizzle-kit studio`：本地/远程可视化查看数据。
 *
 * 迁移的"执行"永远由 wrangler 负责（wrangler d1 migrations apply），
 * 因为 D1 的迁移记录表（d1_migrations）由 wrangler 维护。
 * 因此：禁止使用 `drizzle-kit push`，它会绕过 migrations 目录直改库结构。
 *
 * 生成后的 SQL 必须人工补齐 Drizzle/KV 无法表达的约束：
 * CHECK、部分索引的 WHERE、以及双列唯一性组合的业务含义。
 */
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/schema/index.ts',
  out: './migrations',
  driver: 'd1-http',
  dbCredentials: {
    // 仅 studio / push 需要；从环境变量读取，绝不写死
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? '',
    databaseId: process.env.CLOUDFLARE_DATABASE_ID ?? '',
    token: process.env.CLOUDFLARE_D1_TOKEN ?? '',
  },
  verbose: true,
  strict: true,
});
