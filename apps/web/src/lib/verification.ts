/**
 * 身份验证等级：只回答"这个人是谁被谁证明过"。
 *
 *   VERIFIED      Steam OpenID 绑定过，归属由 Steam 证明（最强）
 *   CLAIMED       只填了数字 ID：证明"这个账号存在"，不证明"是你的"
 *   SELF_REPORTED 两者都没有，段位全靠自己填
 *
 * 注意它和 `rankSource` 是两条线：管理员可以把段位设成 ADMIN_SET（分数可信），
 * 但身份仍然是 SELF_REPORTED（没人证明这是他的账号）。列表上的徽章与筛选
 * 一律只看**身份**，否则"已认证"这个词会变得没法解释。
 */
export type VerificationLevel = 'VERIFIED' | 'CLAIMED' | 'SELF_REPORTED';

export const VERIFICATION_LABEL: Record<VerificationLevel, string> = {
  VERIFIED: 'Steam 认证',
  CLAIMED: '数字 ID',
  SELF_REPORTED: '自报',
};

/** 悬浮说明：为什么这个等级不能当作"这个人说的都是真的" */
export const VERIFICATION_HINT: Record<VerificationLevel, string> = {
  VERIFIED: 'Steam OpenID 绑定：账号归属由 Steam 证明',
  CLAIMED: '数字 ID 声明：只证明这个账号存在，不证明是你的',
  SELF_REPORTED: '未验证：段位是自己填的，没有外部凭据',
};

export const VERIFICATION_TONE: Record<VerificationLevel, 'ok' | 'warn' | 'idle'> = {
  VERIFIED: 'ok',
  CLAIMED: 'warn',
  SELF_REPORTED: 'idle',
};

/** 把接口里的 game_accounts.verification 归一到三档 */
export function verificationOf(accountVerification: string | null | undefined): VerificationLevel {
  if (accountVerification === 'VERIFIED') return 'VERIFIED';
  if (accountVerification === 'CLAIMED') return 'CLAIMED';
  return 'SELF_REPORTED';
}

export type VerificationFilter = VerificationLevel | 'ALL';

export const VERIFICATION_FILTER_OPTIONS: Array<{ label: string; value: VerificationFilter }> = [
  { label: '全部', value: 'ALL' },
  { label: 'Steam 认证', value: 'VERIFIED' },
  { label: '数字 ID', value: 'CLAIMED' },
  { label: '自报', value: 'SELF_REPORTED' },
];
