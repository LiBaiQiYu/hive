import { Hono } from 'hono';
import { z } from 'zod';
import { ApiError } from '@hive/shared';
import type { AppEnv } from '../env';
import { requireAdmin } from '../guard';
import { readSettings, saveRegistrationRequireInvite } from '../services/settings';

export const adminSettingsRoutes = new Hono<AppEnv>();

/**
 * 可写的设置项。加一个新开关时：
 *   1. `services/settings.ts` 的 AppSettings / readSettings 加字段；
 *   2. 这里的 schema 加一个可选字段；
 *   3. `PUT` 里补一段"变了才写 + 写审计"。
 * 不要用一个 `Record<string, string>` 收所有东西——那样任何人都能把
 * 没定义过的 key 写进库，读取端还得猜哪个值算真。
 */
const updateSchema = z.object({
  registrationRequireInvite: z.boolean().optional(),
});

/* -------------------------------------------------------------------------- */
adminSettingsRoutes.get('/', async (c) => {
  requireAdmin(c);
  const settings = await readSettings(c.env);
  return c.json({ data: settings, meta: { requestId: c.get('requestId') } });
});

/* -------------------------------------------------------------------------- */
adminSettingsRoutes.put('/', async (c) => {
  const adminId = requireAdmin(c);

  const parsed = updateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw new ApiError('VALIDATION_FAILED', '输入不合法', parsed.error.flatten().fieldErrors);
  }
  if (parsed.data.registrationRequireInvite === undefined) {
    throw new ApiError('VALIDATION_FAILED', '没有要更新的设置');
  }

  const before = await readSettings(c.env);

  // 值没变就不写：后台的「保存」很可能会被连点两下，
  // 而审计里出现两条"改成同一个值"只会让人以为真的改过两次
  if (before.registrationRequireInvite === parsed.data.registrationRequireInvite) {
    return c.json({ data: before, meta: { requestId: c.get('requestId') } });
  }

  const after = await saveRegistrationRequireInvite(c.env, {
    actorId: adminId,
    requireInvite: parsed.data.registrationRequireInvite,
    before: before.registrationRequireInvite,
    requestId: c.get('requestId') ?? null,
  });

  return c.json({ data: after, meta: { requestId: c.get('requestId') } });
});
