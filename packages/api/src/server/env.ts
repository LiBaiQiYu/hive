/**
 * Node 端的运行时环境：把 `process.env` 组装成后端认识的 `Env`。
 *
 * 与 Workers 的区别只在于「绑定从哪来」：
 *   · Workers 由 `wrangler.jsonc` 注入 DB / EMAIL / vars / secrets；
 *   · 自建由这里读环境变量，并把 SQLite 与 SMTP 包成同样的形状。
 *
 * 业务代码（routes / services）对此完全无感 —— 这是能"一套代码两处跑"的关键。
 */
import { NodeD1 } from './node-d1';
import { createSmtpMailBinding, readSmtpConfig } from './smtp-mailer';
import type { Env } from '../env';

/** 必填项缺失时直接退出：宁可起不来，也别带着半套配置对外服务 */
const REQUIRED = ['PASSWORD_PEPPER', 'IP_HASH_SALT', 'APP_ORIGIN'] as const;

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    console.error(`[hive] 缺少必填环境变量 ${name}（见 deploy/.env.production.example）`);
    process.exit(1);
  }
  return value;
}

export interface NodeRuntime {
  env: Env;
  /** 关库用（优雅退出时调用） */
  close: () => void;
}

export function createNodeRuntime(): NodeRuntime {
  for (const name of REQUIRED) required(name);

  const dbPath = process.env.DB_PATH?.trim() || './data/hive.db';
  const db = new NodeD1(dbPath);

  const smtp = readSmtpConfig(process.env);
  if (!smtp) {
    // 不致命：密码找回与开赛提醒会退化成"只记审计不发信"，其余功能照常
    console.warn('[hive] 未配置 SMTP_HOST / SMTP_FROM，出站邮件功能不可用');
  }

  const env: Env = {
    DB: db,
    EMAIL: smtp ? createSmtpMailBinding(smtp) : undefined,
    APP_ENV: process.env.APP_ENV?.trim() || 'production',
    APP_ORIGIN: required('APP_ORIGIN'),
    PASSWORD_PEPPER: required('PASSWORD_PEPPER'),
    IP_HASH_SALT: required('IP_HASH_SALT'),
    PASSWORD_PBKDF2_ITERATIONS: process.env.PASSWORD_PBKDF2_ITERATIONS ?? '120000',
    SESSION_TTL_DAYS: process.env.SESSION_TTL_DAYS ?? '14',
    SESSION_IDLE_TIMEOUT_HOURS: process.env.SESSION_IDLE_TIMEOUT_HOURS ?? '72',
    ADMIN_ADJUSTMENT_LIMIT: process.env.ADMIN_ADJUSTMENT_LIMIT,
    AUTO_FINALIZE_ODD: process.env.AUTO_FINALIZE_ODD,
    STEAM_WEB_API_KEY: process.env.STEAM_WEB_API_KEY,
    STRATZ_API_TOKEN: process.env.STRATZ_API_TOKEN,
    SYNC_JOB_BATCH_SIZE: process.env.SYNC_JOB_BATCH_SIZE,
    SYNC_JOB_LEASE_SECONDS: process.env.SYNC_JOB_LEASE_SECONDS,
    AUDIT_RETENTION_DAYS: process.env.AUDIT_RETENTION_DAYS,
    // 自建实例配了 SMTP，找回就该走"填邮箱直接发信"这条路；
    // 显式配置可覆盖（比如你把 SMTP 关掉、只想让玩家找管理员）
    RESET_FLOW: process.env.RESET_FLOW?.trim() || (smtp ? 'self' : 'admin'),
  };

  return {
    env,
    close: () => db.close(),
  };
}
