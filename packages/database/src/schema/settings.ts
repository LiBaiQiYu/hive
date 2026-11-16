/**
 * 运行期设置（迁移 0018）。
 *
 * 这里放"管理员应该能在后台改、又不值得为它发一次版"的开关：
 * 目前只有注册方式（是否需要邀请码）。
 *
 * value 一律字符串：布尔用 '1' / '0'。读取时统一走
 * `packages/api/src/services/settings.ts`，别在路由里自己 parse——
 * 同一份默认值写两处，迟早出现"关掉了但注册页还显示要邀请码"。
 */
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { users } from './users';
import { TS_NOW } from './_shared';

export const appSettings = sqliteTable(
  'app_settings',
  {
    /** 点号命名空间，如 registration.require_invite */
    key: text('key').primaryKey(),
    value: text('value').notNull(),
    /** 谁最后改的；系统播种时为 NULL */
    updatedBy: text('updated_by').references(() => users.id, { onDelete: 'set null' }),
    updatedAt: integer('updated_at').notNull().default(TS_NOW),
  },
  // 没有二级索引：这张表永远只有几行，读全表比维护索引划算。
  // 空数组是给 check_parity 留的"表以 }, 收尾"的形状，别删
  () => [],
);

export type AppSetting = typeof appSettings.$inferSelect;
