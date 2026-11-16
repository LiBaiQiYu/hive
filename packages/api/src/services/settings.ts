/**
 * 运行期设置（`app_settings`，迁移 0018）。
 *
 * 为什么要有这一层：
 *   注册方式原来是部署级配置（`REGISTRATION_REQUIRE_INVITE`），开/关一次要改
 *   wrangler.jsonc 再发一版；而"这个月要不要邀请码"是运营决定，不该等部署。
 *   现在它是一行数据库记录，后台「系统设置」写、注册接口和注册页读。
 *
 * 唯一真源：
 *   key 只在这里定义；默认值只在这里定义。路由 / 前端都别自己写一份，
 *   否则会出现"后台显示已关闭、注册页还要邀请码"这种自相矛盾。
 */
import { newId } from '@hive/shared';
import type { Env } from '../env';

/** 可配置项清单。key 是数据库里的身份，写进库以后不要再改 */
export const SETTING_KEYS = {
  /**
   * 注册是否需要邀请码。
   * '1' = 邀请制（注册必须带有效码）；'0' = 开放注册（不要求，传了也忽略）。
   */
  registrationRequireInvite: 'registration.require_invite',
} as const;

export interface AppSettings {
  registrationRequireInvite: boolean;
}

/**
 * 默认值刻意与迁移 0018 的播种值一致：**开放注册**。
 * 它只在"那一行不见了"时兜底（老库没迁移、被手工删掉），
 * 正常路径读的是数据库，不是这里。
 */
export const DEFAULT_SETTINGS: AppSettings = { registrationRequireInvite: false };

/** 只认 '1'/'true' 与 '0'/'false'，脏数据回落默认值而不是抛错 */
export function parseSettingBool(raw: string | null | undefined, fallback: boolean): boolean {
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  return fallback;
}

/** 一次读全表（永远只有几行），未知 key 直接忽略 */
export async function readSettings(env: Env): Promise<AppSettings> {
  const rows = await env.DB.prepare(`SELECT key, value FROM app_settings`).all<{
    key: string;
    value: string;
  }>();

  const values = new Map((rows.results ?? []).map((row) => [row.key, row.value]));
  return {
    registrationRequireInvite: parseSettingBool(
      values.get(SETTING_KEYS.registrationRequireInvite),
      DEFAULT_SETTINGS.registrationRequireInvite,
    ),
  };
}

/**
 * 写注册方式开关，并留下一条审计。
 *
 * 值 + 审计放进同一个 `batch`（D1 里就是事务）：不能出现"开关翻过去了、
 * 审计里查不到是谁翻的"，也不能反过来留下一条没生效的审计。
 */
export async function saveRegistrationRequireInvite(
  env: Env,
  input: { actorId: string; requireInvite: boolean; before: boolean; requestId: string | null },
): Promise<AppSettings> {
  const now = Date.now();
  const key = SETTING_KEYS.registrationRequireInvite;
  const value = input.requireInvite ? '1' : '0';

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO app_settings (key, value, updated_by, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET
         value = excluded.value,
         updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`,
    ).bind(key, value, input.actorId, now),
    env.DB.prepare(
      `INSERT INTO audit_logs (id, actor_id, actor_role, action, entity_type, entity_id,
         after_json, request_id, created_at)
       VALUES (?, ?, 'ADMIN', 'settings.update', 'app_setting', ?, ?, ?, ?)`,
    ).bind(
      newId(now),
      input.actorId,
      key,
      JSON.stringify({ key, before: input.before, after: input.requireInvite }),
      input.requestId,
      now,
    ),
  ]);

  return { registrationRequireInvite: input.requireInvite };
}
