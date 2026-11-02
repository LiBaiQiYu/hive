/**
 * 段位编码的唯一出口。
 *
 * 约定：`rank_tier` 十位是勋章（1–8），个位是星级（0–5），冠绝固定为 80。
 * 现在有三处要显示段位（玩家卡、我的主页身份卡、排行榜），
 * 名字清单只留这一份——否则迟早出现"卡片上是万古流芳、排行榜写成万古"。
 */

export const MEDAL_NAMES = [
  '先锋',
  '卫士',
  '中军',
  '统帅',
  '传奇',
  '万古流芳',
  '超凡入圣',
  '冠绝',
] as const;

export interface RankParts {
  /** 1–8，等于 MEDAL_NAMES 的下标 + 1 */
  medal: number;
  /** 0–5；冠绝恒为 0 */
  star: number;
  /** 中文勋章名，如「传奇」 */
  name: string;
}

/** 把 rank_tier 拆成勋章与星级；没有数据或编码非法（< 10）时返回 null */
export function rankParts(tier: number | null | undefined): RankParts | null {
  if (typeof tier !== 'number' || !Number.isFinite(tier) || tier < 10) return null;
  const medal = Math.floor(tier / 10);
  const star = tier % 10;
  const name = MEDAL_NAMES[medal - 1];
  if (!name) return null;
  return { medal, star, name };
}

/** 一句话段位，例如「传奇 3 星」「冠绝」；没有数据时返回空串 */
export function rankLabel(tier: number | null | undefined): string {
  const parts = rankParts(tier);
  if (!parts) return '';
  // 冠绝只有勋章没有星级，别拼出「冠绝 0 星」
  return parts.medal === 8 ? parts.name : `${parts.name} ${parts.star} 星`;
}

/** 天梯分的悬停说明：为什么有人有段位却没有 MMR */
export function mmrHint(
  mmr: number | null,
  tier: number | null,
  source: string | null | undefined,
): string {
  if (mmr !== null) return source === 'SELF_REPORTED' ? '自己填写的天梯分' : '账号同步来的天梯分';
  if (tier !== null) return '段位来自 Steam / OpenDota / STRATZ 同步，这类数据不含天梯分';
  return '还没有段位数据：绑定 Steam，或在「我的主页 → 游戏身份」里手动填写';
}
