#!/usr/bin/env node
/**
 * 应急重置某人的密码（用于"唯一的管理员把自己锁在门外"）。
 *
 * 正常流程不需要这个脚本：任意管理员都能在「后台 → 成员管理 → 重置密码」生成
 * 一次性临时口令。但那条路径要求你先能以管理员身份登录，所以当最后一个管理员
 * 忘了密码时，只能用这个脚本直接改库。
 *
 * 用法：
 *   node scripts/reset-password.mjs <username> [--password <新密码>] [--out reset.sql]
 *
 * pepper 从哪来（优先级从高到低）：
 *   1. 命令行 --pepper
 *   2. 环境变量 PASSWORD_PEPPER
 *   3. packages/api/.dev.vars 里的 PASSWORD_PEPPER（本地库用这套）
 *
 * 线上库用的是 Cloudflare secret 里的 pepper，本机只存在 backups/ 或你自己的密码管理器里；
 * 指到错误的 pepper 不会报错，只会让所有人（包括你）都登录不上，改之前先确认清楚。
 *
 * 脚本只生成 SQL，不直接执行——远端库要你自己确认目标环境：
 *   本地： pnpm dlx wrangler d1 execute hive --local --persist-to packages/database/.wrangler/state \
 *            -c packages/database/wrangler.d1.jsonc --file reset-password.sql
 *   线上： pnpm dlx wrangler d1 execute hive --remote -c packages/database/wrangler.d1.jsonc \
 *            --file reset-password.sql
 *
 * 哈希算法与 packages/api/src/password.ts 保持一致（那边是唯一权威实现）：
 *   pepperMaterial = HMAC-SHA256(pepper, password)
 *   hash           = PBKDF2-HMAC-SHA256(pepperMaterial, salt, iterations, 32 字节)
 *   存储格式：pbkdf2_sha256$p1$<iterations>$<salt>$<hash>（base64url，无 padding）
 */
import { createHmac, pbkdf2Sync, randomBytes, randomInt } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEV_VARS = join(ROOT, 'packages/api/.dev.vars');
const DEFAULT_ITERATIONS = 50_000;
const ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';

function arg(name, fallback = undefined) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function fail(message) {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

function fromDevVars() {
  try {
    const text = readFileSync(DEV_VARS, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*PASSWORD_PEPPER\s*=\s*(.*)$/.exec(line);
      if (match) return match[1].trim().replace(/^["']|["']$/g, '');
    }
  } catch {
    /* 文件不存在就算了 */
  }
  return null;
}

function toBase64Url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function hashPassword(password, pepper, iterations) {
  const material = createHmac('sha256', pepper).update(password).digest();
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(material, salt, iterations, 32, 'sha256');
  return ['pbkdf2_sha256', 'p1', String(iterations), toBase64Url(salt), toBase64Url(hash)].join('$');
}

function generatePassword(length = 12) {
  let out = '';
  while (out.length < length) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

const username = process.argv[2];
if (!username || username.startsWith('--')) {
  fail('用法：node scripts/reset-password.mjs <username> [--password <新密码>] [--out reset.sql]');
}

const pepper = arg('pepper') ?? process.env.PASSWORD_PEPPER ?? fromDevVars();
if (!pepper) {
  fail(
    '找不到 PASSWORD_PEPPER。请用 --pepper 传入，或设置同名环境变量，或在 packages/api/.dev.vars 里配置。\n' +
      '  · 本地库：直接复用 packages/api/.dev.vars\n' +
      '  · 线上库：必须用 Cloudflare secret 里那一份，用错会让所有人登录失败',
  );
}

const iterations = Number.parseInt(arg('iterations', String(DEFAULT_ITERATIONS)), 10);
if (!Number.isInteger(iterations) || iterations <= 0) fail('--iterations 必须是正整数');

const password = arg('password') ?? generatePassword();
if (password.length < 10) fail('新密码至少 10 位（与注册、改密码的校验一致）');

const hash = hashPassword(password, pepper, iterations);
const now = Date.now();
const escapedUser = username.replace(/'/g, "''");
const sql = [
  '-- 由 scripts/reset-password.mjs 生成。执行后请让本人立刻到「账号设置」改密码。',
  `-- 目标账号：${username}`,
  `UPDATE users`,
  `   SET password_hash = '${hash}', failed_login_count = 0, locked_until = NULL, updated_at = ${now}`,
  ` WHERE username = '${escapedUser}';`,
  '',
  '-- 顺手作废该账号所有会话（改完密码还在别处登录着就没意义了）',
  `UPDATE sessions SET revoked_at = ${now} WHERE user_id = (SELECT id FROM users WHERE username = '${escapedUser}') AND revoked_at IS NULL;`,
  '',
].join('\n');

const out = arg('out', 'reset-password.sql');
writeFileSync(join(process.cwd(), out), sql, 'utf8');

console.log(`\n账号：${username}`);
console.log(`临时密码：${password}`);
console.log(`哈希：${hash.slice(0, 34)}…（${hash.split('$')[2]} 次迭代）`);
console.log(`\nSQL 已写入：${out}\n`);
console.log('执行方式（注意 --local / --remote 的区别）：');
console.log(
  '  本地： pnpm dlx wrangler d1 execute hive --local --persist-to packages/database/.wrangler/state -c packages/database/wrangler.d1.jsonc --file ' +
    out,
);
console.log(
  '  线上： pnpm dlx wrangler d1 execute hive --remote -c packages/database/wrangler.d1.jsonc --file ' + out,
);
console.log('\n改完请本人登录后到「账号设置」立即修改密码。\n');
