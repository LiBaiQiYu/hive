import type { Context } from 'hono';
import { ApiError } from '@hive/shared';
import type { AppEnv } from './env';

/** 取当前登录用户 id；未登录直接 401 */
export function requireUser(c: Context<AppEnv>): string {
  const userId = c.get('userId');
  if (!userId) throw new ApiError('UNAUTHENTICATED', '请先登录');
  return userId;
}

/** 管理员守卫。所有 /api/admin/* 必须经过它，且必须服务端判断，不能依赖前端隐藏入口 */
export function requireAdmin(c: Context<AppEnv>): string {
  const userId = requireUser(c);
  if (c.get('role') !== 'ADMIN') throw new ApiError('FORBIDDEN', '需要管理员权限');
  return userId;
}
