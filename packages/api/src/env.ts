/**
 * 运行时绑定的类型契约。
 *
 * 同一个后端跑在两种运行时上：
 *   · Cloudflare Workers —— `DB` 是 D1，`EMAIL` 是 send_email 绑定；
 *   · 自建服务器（Node）—— `DB` 是 node:sqlite 的 D1 兼容层，`EMAIL` 是 SMTP 配置。
 *
 * 所以这里的 `DB` 类型写成"两者都满足"的最小接口（见 db/binding.ts），
 * 而不是写死 D1Database —— 否则 Node 侧的类型检查过不去。
 */
import type { D1LikeDatabase } from './db/types';

/**
 * 出站邮件的两条通路。
 *
 * Workers 侧由 `wrangler.jsonc` 的 `send_email` 绑定注入了 `{ send(message) }`；
 * Node 侧由入口把 nodemailer 包成同一个形状。业务代码只认 `.send()`，
 * 不关心底下是 Cloudflare 还是 SMTP。
 */
export interface MailBinding {
  send(message: { from: string; to: string; raw: string }): Promise<void>;
}

export interface Env {
  DB: D1LikeDatabase;
  EMAIL?: MailBinding;
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
  /** 可选：只用于取 Steam 昵称与头像，不参与身份校验；缺失时绑定仍应成功 */
  STEAM_WEB_API_KEY?: string;
  /**
   * 可选：STRATZ 的 GraphQL token（Bearer）。配了就用 STRATZ 抓段位，
   * 没配则退回 OpenDota —— 后者按 IP 计额度，而 Worker 出口 IP 是共享的。
   */
  STRATZ_API_TOKEN?: string;
  /** outbox 每次抽干的任务数 / 租约秒数 */
  SYNC_JOB_BATCH_SIZE?: string;
  SYNC_JOB_LEASE_SECONDS?: string;
  /** 审计日志保留天数，每日维护按它裁剪 */
  AUDIT_RETENTION_DAYS?: string;
  /**
   * 密码找回走哪条路（见 `routes/config.ts` 的 `resolveResetFlow`）：
   *   `self`    —— 配了 SMTP，玩家填邮箱我们发信（自建部署）；
   *   `inbound` —— 玩家发信到 reset@，Worker 回信（Cloudflare 免费版）；
   *   `admin`   —— 只能找管理员重置。
   * 不配时按 `inbound` 处理，保持 Workers 上的既有行为。
   */
  RESET_FLOW?: string;
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
