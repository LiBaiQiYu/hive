/** Worker 绑定的类型契约。与 packages/api/wrangler.jsonc 的 vars/secrets 一一对应。 */
import type { EmailMessage } from 'cloudflare:email';

export interface Env {
  DB: D1Database;
  /**
   * Cloudflare Email Sending 绑定（`wrangler.jsonc` 的 `send_email`）。
   * 免费版只能发给"已验证目的地地址"，所以绑定是收窄的；本地 `pnpm dev` 没有它。
   */
  EMAIL?: { send(message: EmailMessage): Promise<void> };
  APP_ENV: string;
  APP_ORIGIN: string;
  PASSWORD_PEPPER: string;
  IP_HASH_SALT: string;
  PASSWORD_PBKDF2_ITERATIONS: string;
  SESSION_TTL_DAYS: string;
  SESSION_IDLE_TIMEOUT_HOURS: string;
  /**
   * 管理员评分修正的基数上限（默认 150，随置信度放宽到 150+350）。
   * 由 `routes/admin-ratings.ts` 读取；数据库的 CHECK 放宽到 ±500，所以
   * 调这个值不需要改表结构。
   */
  ADMIN_ADJUSTMENT_LIMIT?: string;
  /** 人数卡在两档之间时是否允许自动按部分人数开局；默认 false，必须由管理员显式选择 */
  AUTO_FINALIZE_ODD?: string;
  REGISTRATION_REQUIRE_INVITE?: string;
  /** 可选：只用于取 Steam 昵称与头像，不参与身份校验；缺失时绑定仍应成功 */
  STEAM_WEB_API_KEY?: string;
  /**
   * 可选：STRATZ 的 GraphQL token（Bearer）。配了就用 STRATZ 抓段位，
   * 没配则退回 OpenDota —— 后者按 IP 计额度，而 Worker 出口 IP 是共享的。
   */
  STRATZ_API_TOKEN?: string;
  /** outbox 每次抽干的任务数 / 租约秒数（wrangler.jsonc 的 vars） */
  SYNC_JOB_BATCH_SIZE?: string;
  SYNC_JOB_LEASE_SECONDS?: string;
  /** 审计日志保留天数，每日维护按它裁剪 */
  AUDIT_RETENTION_DAYS?: string;
}

export interface Variables {
  requestId: string;
  userId: string | null;
  role: 'PLAYER' | 'ADMIN' | null;
}

export type AppEnv = { Bindings: Env; Variables: Variables };

export function intVar(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Cookie 要不要加 Secure —— **只有实际对外地址是 https 才加**。
 *
 * 为什么不能写死 true：Secure 的语义是"只在 HTTPS 下保存和回传"，
 * 而本地 `pnpm dev` 走的是 http://127.0.0.1:8787。部分浏览器会直接丢弃这种
 * Cookie，症状是"登录接口返回 200，但下一个请求不带 Cookie，页面仍是未登录"。
 *
 * 判断优先用 APP_ORIGIN（本地脚本已注入 http://127.0.0.1:8787），
 * 没配置时回退到请求自身的 origin。
 */
export function cookieSecure(env: Env, requestUrl: string): boolean {
  const origin = env.APP_ORIGIN || new URL(requestUrl).origin;
  return origin.startsWith('https:');
}
