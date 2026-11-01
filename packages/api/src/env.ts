/** Worker 绑定的类型契约。与 packages/api/wrangler.jsonc 的 vars/secrets 一一对应。 */
export interface Env {
  DB: D1Database;
  APP_ENV: string;
  APP_ORIGIN: string;
  PASSWORD_PEPPER: string;
  IP_HASH_SALT: string;
  PASSWORD_PBKDF2_ITERATIONS: string;
  SESSION_TTL_DAYS: string;
  SESSION_IDLE_TIMEOUT_HOURS: string;
  /** 人数卡在两档之间时是否允许自动按部分人数开局；默认 false，必须由管理员显式选择 */
  AUTO_FINALIZE_ODD?: string;
  REGISTRATION_REQUIRE_INVITE?: string;
  /** 可选：只用于取 Steam 昵称与头像，不参与身份校验；缺失时绑定仍应成功 */
  STEAM_WEB_API_KEY?: string;
  /** outbox 每次抽干的任务数 / 租约秒数（wrangler.jsonc 的 vars） */
  SYNC_JOB_BATCH_SIZE?: string;
  SYNC_JOB_LEASE_SECONDS?: string;
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
