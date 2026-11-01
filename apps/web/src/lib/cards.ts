/**
 * 卡片皮肤的取值与文案。
 *
 * 枚举值必须和 packages/shared 的 CARD_MATERIALS / CARD_FRAMES
 * 以及 migrations/0004+ 的 CHECK 一致 —— 值对不上会被服务端拒绝。
 * 文案只活在前端：服务端不需要知道"鎏金"这种叫法。
 */

export type CardMaterial =
  | 'basic'
  | 'pixel'
  | 'acrylic'
  | 'sparkle'
  | 'holo'
  | 'gold'
  | 'psi';
export type CardFrame =
  | 'none'
  | 'hairline'
  | 'double'
  | 'corners'
  | 'bevel'
  | 'frost'
  | 'spark'
  | 'arc';

export interface CardSkin {
  material: CardMaterial;
  frame: CardFrame;
}

export interface CardOption<T extends string> {
  value: T;
  label: string;
  hint: string;
}

export const CARD_MATERIAL_OPTIONS: CardOption<CardMaterial>[] = [
  { value: 'basic', label: '默认', hint: '近黑战地底，改造前的默认外观' },
  { value: 'pixel', label: '像素', hint: '8-bit 网格底板，直角硬边、块状投影' },
  { value: 'acrylic', label: '亚克力', hint: '磨砂玻璃，透出页面底色的光' },
  { value: 'sparkle', label: '闪耀', hint: '碎钻银白：晶面反光 + 细碎星点' },
  { value: 'holo', label: '全息', hint: '镭射菱格：青绿到紫的虹彩箔' },
  { value: 'gold', label: '金色', hint: '流动金箔：起伏的熔金色带' },
  { value: 'psi', label: '灵能', hint: '破碎色散：碎晶 + 棱镜光刃，倾斜时整片分光位移' },
];

export const CARD_FRAME_OPTIONS: CardOption<CardFrame>[] = [
  { value: 'hairline', label: '发丝线', hint: '一圈细描边，最克制' },
  { value: 'none', label: '无边', hint: '去掉描边，只留材质本身' },
  { value: 'double', label: '双线', hint: '外粗内细的双层描边' },
  { value: 'corners', label: '四角', hint: '只在四个角画折线' },
  { value: 'bevel', label: '浮雕', hint: '内外斜角，像压出来的一块板' },
  { value: 'frost', label: '霜线', hint: '极细冷白线 + 淡蓝辉光，最轻' },
  { value: 'spark', label: '电光', hint: '青色能量轨，边缘带游离光点' },
  { value: 'arc', label: '雷纹', hint: '金琥珀色电弧，参考 Steam 物品边框' },
];

export const DEFAULT_CARD_SKIN: CardSkin = {
  material: 'basic',
  frame: 'hairline',
};

const MATERIALS = CARD_MATERIAL_OPTIONS.map((option) => option.value);
const FRAMES = CARD_FRAME_OPTIONS.map((option) => option.value);

/** 接口给什么就穿什么；脏值 / 老数据一律回落到默认皮肤，别把卡渲染成空白 */
export function normalizeCardSkin(input?: Partial<CardSkin> | null): CardSkin {
  const pick = <T extends string>(list: T[], value: T | undefined, fallback: T): T =>
    value && list.includes(value) ? value : fallback;
  return {
    material: pick(MATERIALS, input?.material, DEFAULT_CARD_SKIN.material),
    frame: pick(FRAMES, input?.frame, DEFAULT_CARD_SKIN.frame),
  };
}

/** 「随便换一个」：只随机材质 + 边框 */
export function randomCardSkin(): CardSkin {
  const pick = <T extends string>(list: T[]): T => list[Math.floor(Math.random() * list.length)] as T;
  return { material: pick(MATERIALS), frame: pick(FRAMES) };
}
