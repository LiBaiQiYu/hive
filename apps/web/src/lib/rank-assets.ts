/**
 * 段位图标（先锋 → 冠绝 8 枚 + 1–5 星 5 枚）。
 *
 * 图来自 STRATZ 的公开素材：`cdn.stratz.com/images/dota2/seasonal_rank/medal_N.png`
 * 与 `star_N.png`，两份都是 256×256 的透明画布，**星星画在画布顶部**——
 * 也就是说把两张图按同一尺寸叠起来，就是官方那颗段位章，不需要任何裁剪或坐标换算。
 *
 * 放在 assets 里由 Vite 打包（带 hash），不要写死外链：一是别给别人的 CDN 引流量，
 * 二是这层素材哪天换域名，站内就会一片裂图。
 */
import medal1 from '../assets/ranks/medal_1.png';
import medal2 from '../assets/ranks/medal_2.png';
import medal3 from '../assets/ranks/medal_3.png';
import medal4 from '../assets/ranks/medal_4.png';
import medal5 from '../assets/ranks/medal_5.png';
import medal6 from '../assets/ranks/medal_6.png';
import medal7 from '../assets/ranks/medal_7.png';
import medal8 from '../assets/ranks/medal_8.png';
import star1 from '../assets/ranks/star_1.png';
import star2 from '../assets/ranks/star_2.png';
import star3 from '../assets/ranks/star_3.png';
import star4 from '../assets/ranks/star_4.png';
import star5 from '../assets/ranks/star_5.png';

/** 勋章：1 先锋 … 8 冠绝（与 rank_tier 的十位对应） */
export const MEDAL_ICONS: Record<number, string> = {
  1: medal1,
  2: medal2,
  3: medal3,
  4: medal4,
  5: medal5,
  6: medal6,
  7: medal7,
  8: medal8,
};

/** 星级：1–5；冠绝没有星级，不会用到这张表 */
export const STAR_ICONS: Record<number, string> = {
  1: star1,
  2: star2,
  3: star3,
  4: star4,
  5: star5,
};
