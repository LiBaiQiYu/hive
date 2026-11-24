/**
 * Node 自建部署的入口。
 *
 * 与 Workers 入口（`src/index.ts`）的关系：
 *   · 同一个 Hono app（`src/app.ts`）——路由、中间件、错误处理完全复用；
 *   · 同一个 `runScheduled` ——两条 Cron 由 `server/scheduler.ts` 驱动；
 *   · 静态资源由 `server/static.ts` 发（等价于 Workers Assets）。
 *
 * 只在自建环境里 import `node:sqlite` / `nodemailer`，Workers 产物不会碰到它们。
 */
import { serve } from '@hono/node-server';
import { resolve } from 'node:path';
import app from '../app';
import type { Env } from '../env';
import { createNodeRuntime } from './env';
import { createStaticHandler } from './static';
import { startScheduler } from './scheduler';

const PORT = Number.parseInt(process.env.PORT ?? '', 10) || 8787;
const HOST = process.env.HOST?.trim() || '0.0.0.0';

const { env, close } = createNodeRuntime();

// 构建产物默认在仓库的 apps/web/dist；容器里用 STATIC_DIR 指过去
const staticDir = resolve(process.env.STATIC_DIR?.trim() || 'apps/web/dist');
const handleStatic = createStaticHandler({
  root: staticDir,
  // HSTS 只在对外是 https 时加：本地 http 访问会被浏览器忽略，但提前加上也没意义
  hsts: (env.APP_ORIGIN ?? '').startsWith('https:'),
});

const server = serve({
  port: PORT,
  hostname: HOST,
  fetch: async (request: Request) => {
    const url = new URL(request.url);

    // /api/* 与 /cdn-cgi/* 进 Hono；其余走静态资源层（与 Workers 的
    // `run_worker_first: ["/api/*"]` 语义一致：静态资源不消耗应用逻辑）
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/cdn-cgi/')) {
      return app.fetch(request, env);
    }
    return handleStatic(request, url);
  },
});

const scheduler = startScheduler(env as Env);

console.log(`[hive] listening on http://${HOST}:${PORT}`);
console.log(`[hive] static: ${staticDir}`);
console.log(`[hive] mail: ${env.EMAIL ? 'smtp' : '(未配置，出站邮件停用)'}`);
console.log(`[hive] app origin: ${env.APP_ORIGIN}`);
console.log(`[hive] db: ${process.env.DB_PATH ?? './data/hive.db'}`);

/** 收到停止信号时先停定时器、再关库，避免写到一半被杀 */
let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[hive] ${signal} received, shutting down`);

  scheduler.stop();
  // 先停止接收新请求，给在途请求一点时间（反向代理通常 5–10 秒超时）
  server.close?.(() => {
    close();
    process.exit(0);
  });

  setTimeout(() => {
    close();
    process.exit(0);
  }, 8_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
