import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { readSettings } from '../services/settings';

export const configRoutes = new Hono<AppEnv>();

/**
 * GET /api/config —— 登录前就要知道的公开配置。
 *
 * 目前只有一件事：注册要不要邀请码。注册页据此决定显不显示邀请码输入框，
 * 服务端注册接口读同一个开关，所以两边不会各说各话。
 *
 * 只放"给游客看也无所谓"的开关；任何密钥、内部开关都不要往这里加。
 */
configRoutes.get('/', async (c) => {
  const settings = await readSettings(c.env);

  // 后台改完必须立刻生效：别让浏览器或边缘把它缓存成上一版
  c.header('cache-control', 'no-store');

  return c.json({
    data: { registrationRequireInvite: settings.registrationRequireInvite },
    meta: { requestId: c.get('requestId') },
  });
});
