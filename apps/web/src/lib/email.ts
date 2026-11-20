/**
 * 占位邮箱判断（与 API 端 packages/api/src/services/notify.ts 的 isPlaceholderEmail 保持一致）。
 *
 * 这些域名不可能是真实收件箱：密码找回归根结底是"往这个地址发一封信"，
 * 占位地址发出去必然收不到，所以前端要在保存/确认时就把话说清楚，
 * 而不是等玩家真忘了密码才发现信寄到了虚空里。
 */
const PLACEHOLDER_DOMAINS = ['hive.local', 'hive.test', 'example.com', 'example.org', 'localhost'];

export function isPlaceholderEmail(email: string | null | undefined): boolean {
  if (!email) return true;
  const lower = email.trim().toLowerCase();
  const at = lower.lastIndexOf('@');
  if (at <= 0) return true;
  return PLACEHOLDER_DOMAINS.includes(lower.slice(at + 1));
}
