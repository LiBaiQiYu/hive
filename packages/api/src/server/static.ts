/**
 * 静态资源：把 Vue 构建产物（apps/web/dist）按 Cloudflare Assets 的语义发出去。
 *
 * 三件必须复刻的事：
 *   1. **SPA 回落**：`/events/xxx` 这类深链没有对应文件，要回 index.html；
 *   2. **缓存策略**：`/assets/*` 带内容哈希 → 长缓存；入口 HTML → 必须重新验证；
 *   3. **安全头**：原来由 `apps/web/public/_headers` 交给边缘加，现在由这里加，
 *      这样即使前面没有 Nginx 也不会裸奔（Nginx 再重复加一次也无害，取交集）。
 */
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
};

/**
 * 与 `apps/web/public/_headers` 保持一致。
 * style-src 必须留 'unsafe-inline'：Naive UI 用 css-render 在运行时注入 <style>，
 * Vue 的 :style 也是内联属性；script 侧不需要，保持 'self'。
 */
const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Permitted-Cross-Domain-Policies': 'none',
  'X-DNS-Prefetch-Control': 'off',
  'Content-Security-Policy': [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "manifest-src 'self'",
  ].join('; '),
};

const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
const HTML_CACHE = 'public, max-age=0, must-revalidate';

export interface StaticServerOptions {
  /** 构建产物根目录（apps/web/dist） */
  root: string;
  /** 是否加 HSTS：只有对外是 https 时才该加 */
  hsts: boolean;
}

function headersFor(pathname: string, isHtml: boolean): Record<string, string> {
  const headers: Record<string, string> = { ...SECURITY_HEADERS };

  // Content-Type 必须显式给：浏览器对 `text/plain` 的 JS 会拒绝执行
  // （strict MIME checking），漏了它页面会一片空白但接口全正常。
  const mime = MIME[extname(pathname).toLowerCase()];
  if (mime) headers['Content-Type'] = mime;

  if (isHtml) {
    headers['Cache-Control'] = HTML_CACHE;
  } else if (pathname.startsWith('/assets/')) {
    headers['Cache-Control'] = IMMUTABLE_CACHE;
  } else {
    // public/ 下的图标等：内容会随文件名固定，但也没哈希，给一天
    headers['Cache-Control'] = 'public, max-age=86400';
  }
  return headers;
}

/** 把路径解析到 root 内，越界（../）直接判空，防目录穿越 */
function resolveInside(root: string, pathname: string): string | null {
  const decoded = decodeURIComponent(pathname);
  const candidate = resolve(join(root, normalize(decoded)));
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (candidate !== root && !candidate.startsWith(rootWithSep)) return null;
  return candidate;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function streamFile(path: string, status: number, headers: Record<string, string>): Response {
  const size = statSync(path).size;
  // Readable.toWeb 返回的是 Node 的 web 流实现，与 Workers 的 ReadableStream
  // 在类型上不"完全一致"（BYOB reader 的签名不同），运行时却是同一个标准对象。
  // 这里显式经 unknown 转一次，别让两套 DOM 声明把这段代码卡住。
  const stream = Readable.toWeb(createReadStream(path)) as unknown as ReadableStream<Uint8Array>;
  return new Response(stream, {
    status,
    headers: { ...headers, 'Content-Length': String(size) },
  });
}

export function createStaticHandler(options: StaticServerOptions) {
  const root = resolve(options.root);
  if (!isFile(join(root, 'index.html'))) {
    throw new Error(`静态资源目录里没有 index.html：${root}（先跑 pnpm build）`);
  }

  const baseHeaders = (): Record<string, string> =>
    options.hsts
      ? { ...SECURITY_HEADERS, 'Strict-Transport-Security': 'max-age=15552000; includeSubDomains' }
      : { ...SECURITY_HEADERS };

  return function handleStatic(request: Request, url: URL): Response {
    // 只处理读请求；其余方法交回上层（比如 405）
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405, headers: baseHeaders() });
    }

    const pathname = url.pathname === '/' ? '/index.html' : url.pathname;

    // 1) 命中真实文件（带扩展名的一定是静态资源）
    const target = resolveInside(root, pathname);
    if (target && isFile(target)) {
      const isHtml = extname(target) === '.html';
      return streamFile(target, 200, { ...baseHeaders(), ...headersFor(pathname, isHtml) });
    }

    // 2) 有扩展名却没找到 → 真 404，不要回落成 HTML（否则浏览器把 JS 当页面解析）
    if (extname(pathname) !== '') {
      return new Response('Not Found', {
        status: 404,
        headers: { ...baseHeaders(), 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }

    // 3) 无扩展名 → SPA 深链，回 index.html（状态码 200，前端路由自己决定渲染什么）
    return streamFile(join(root, 'index.html'), 200, {
      ...baseHeaders(),
      ...headersFor('/index.html', true),
    });
  };
}
