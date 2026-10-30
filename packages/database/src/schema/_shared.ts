import { sql } from 'drizzle-orm';

/**
 * 时间列兜底默认值：UTC Unix 毫秒。
 *
 * 注意：SQL 侧只保证秒精度（strftime 的限制），业务写入必须显式传入毫秒时间戳。
 * 这里保留默认值是为了让裸 SQL / seed 脚本也能安全插入，而不是提供给应用层偷懒。
 */
export const TS_NOW = sql`(CAST(strftime('%s', 'now') AS INTEGER) * 1000)`;
