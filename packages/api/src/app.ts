import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { secureHeaders } from 'hono/secure-headers';
import { ApiError, CSRF_HEADER, SESSION_COOKIE } from '@hive/shared';
import type { AppEnv } from './env';
import { authRoutes } from './routes/auth';
import { eventRoutes } from './routes/events';
import { adminEventRoutes } from './routes/admin-events';
import { adminMatchRoutes, publicMatchRoutes } from './routes/matches';
import { meRoutes } from './routes/me';
import { adminInviteRoutes } from './routes/admin-invites';
import { adminRatingRoutes } from './routes/admin-ratings';
import { steamRoutes } from './routes/steam-auth';
import { leaderboardRoutes } from './routes/leaderboard';
import { playerRoutes } from './routes/players';
import { adminDashboardRoutes } from './routes/admin-dashboard';
import { adminUserRoutes } from './routes/admin-users';
import { adminJobRoutes } from './routes/admin-jobs';
import { adminAuditRoutes } from './routes/admin-audit';
import { readSession } from './session';

const app = new Hono<AppEnv>();

// 1) 每个请求一个 id，贯穿响应头、日志与审计
app.use('*', async (c, next) => {
  const requestId = crypto.randomUUID();
  c.set('requestId', requestId);
  c.header('x-request-id', requestId);
  await next();
});

// 2) 安全响应头（CSP / X-Content-Type-Options / Referrer-Policy）
app.use('*', secureHeaders());

// 3) CSRF：SameSite=Lax 挡表单提交，自定义头挡跨站脚本化请求
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
app.use('/api/*', async (c, next) => {
  if (UNSAFE.has(c.req.method)) {
    if (c.req.header(CSRF_HEADER) !== '1') {
      throw new ApiError('FORBIDDEN', `缺少 ${CSRF_HEADER} 请求头`);
    }
    const origin = c.req.header('origin');
    // 除请求自身 origin 外也信任 APP_ORIGIN：`wrangler dev --remote` 下 Worker 跑在边缘，
    // 看到的 request.url 是生产域名，而浏览器发来的 Origin 是 http://127.0.0.1:8787，
    // 只比 request.url 会把 remote 模式下的登录全部挡成 403。
    const allowed = new Set([new URL(c.req.url).origin]);
    if (c.env.APP_ORIGIN) allowed.add(c.env.APP_ORIGIN);
    if (origin && !allowed.has(origin)) {
      throw new ApiError('FORBIDDEN', '请求来源不合法');
    }
  }
  await next();
});

// 4) 会话解析（不强制登录，仅填充上下文）
app.use('/api/*', async (c, next) => {
  c.set('userId', null);
  c.set('role', null);
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    const session = await readSession(c.env, token);
    if (session) {
      c.set('userId', session.userId);
      c.set('role', session.role);
    }
  }
  await next();
});

app.route('/api/auth', authRoutes);
app.route('/api/auth/steam', steamRoutes);
app.route('/api/events', eventRoutes);
app.route('/api/admin/events', adminEventRoutes);
app.route('/api/me', meRoutes);
app.route('/api/admin/invite-codes', adminInviteRoutes);
app.route('/api/admin/ratings', adminRatingRoutes);
app.route('/api/admin/matches', adminMatchRoutes);
app.route('/api/matches', publicMatchRoutes);
app.route('/api/leaderboard', leaderboardRoutes);
app.route('/api/players', playerRoutes);
app.route('/api/admin/dashboard', adminDashboardRoutes);
app.route('/api/admin/users', adminUserRoutes);
app.route('/api/admin/jobs', adminJobRoutes);
app.route('/api/admin/audit-logs', adminAuditRoutes);

app.get('/api/health', (c) =>
  c.json({
    data: { ok: true, env: c.env.APP_ENV, now: new Date().toISOString() },
    meta: { requestId: c.get('requestId') },
  }),
);

// 统一错误响应：客户端只看到 code / message / requestId，不暴露栈
app.notFound((c) =>
  c.json(
    {
      error: { code: 'NOT_FOUND', message: '接口不存在' },
      meta: { requestId: c.get('requestId') ?? null },
    },
    404,
  ),
);

app.onError((err, c) => {
  const requestId = c.get('requestId') ?? null;

  if (err instanceof ApiError) {
    return c.json(
      { error: { code: err.code, message: err.message, details: err.details }, meta: { requestId } },
      err.status as 400,
    );
  }

  console.error('unhandled', { requestId, message: err instanceof Error ? err.message : String(err) });
  return c.json(
    { error: { code: 'INTERNAL', message: '服务器内部错误' }, meta: { requestId } },
    500,
  );
});

export default app;
