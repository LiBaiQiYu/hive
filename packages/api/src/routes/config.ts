import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { readSettings } from '../services/settings';

export const configRoutes = new Hono<AppEnv>();

/**
 * 密码找回走哪条路 —— 两套运行时的能力不同，如实告诉前端，别让它猜：
 *
 *   · `self`    ：配了 SMTP（自建服务器）。玩家填邮箱，我们直接发信；
 *   · `inbound` ：Workers 免费版。玩家发信到 reset@，Worker 回信带链接；
 *   · `admin`   ：既没有 SMTP 也没有收信入口，只能找管理员重置。
 *
 * 前端据此决定登录页显示输入框还是显示"去发邮件"的说明。三个值都不含
 * 任何密钥，放在公开配置里是安全的。
 */
export type ResetFlow = 'self' | 'inbound' | 'admin';

export function resolveResetFlow(env: { RESET_FLOW?: string }): ResetFlow {
  const raw = env.RESET_FLOW?.trim().toLowerCase();
  if (raw === 'self' || raw === 'inbound' || raw === 'admin') return raw;
  // 没显式配置时按 Workers 的默认形态处理（既有行为）
  return 'inbound';
}

/**
 * GET /api/config —— 登录前就要知道的公开配置。
 *
 * 只放"给游客看也无所谓"的开关；任何密钥、内部开关都不要往这里加。
 */
configRoutes.get('/', async (c) => {
  const settings = await readSettings(c.env);

  // 后台改完必须立刻生效：别让浏览器或边缘把它缓存成上一版
  c.header('cache-control', 'no-store');

  return c.json({
    data: {
      registrationRequireInvite: settings.registrationRequireInvite,
      passwordResetFlow: resolveResetFlow(c.env),
    },
    meta: { requestId: c.get('requestId') },
  });
});
