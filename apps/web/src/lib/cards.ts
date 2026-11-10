/**
 * 卡片皮肤的取值与文案。
 *
 * 枚举值必须和 packages/shared 的 CARD_MATERIALS / CARD_FRAMES /
 * CARD_FRAME_COLORS / CARD_FRAME_EFFECTS 以及 migrations/0004+ 的 CHECK 一致
 * —— 值对不上会被服务端拒绝。
 * 文案只活在前端：服务端不需要知道"鎏金"这种叫法。
 */

export type CardMaterial =
  | 'basic'
  | 'pixel'
  | 'acrylic'
  | 'sparkle'
  | 'holo'
  | 'gold'
  | 'psi'
  | 'infinity'
  | 'mirror';
export type CardFrame =
  | 'none'
  | 'hairline'
  | 'double'
  | 'corners'
  | 'bevel'
  | 'frost'
  | 'spark'
  | 'arc';
export type CardFrameColor =
  | 'auto'
  | 'gold'
  | 'ice'
  | 'cyan'
  | 'violet'
  | 'rose'
  | 'emerald'
  | 'rainbow';
export type CardFrameEffect = 'steady' | 'breathe' | 'blink';

export interface CardSkin {
  material: CardMaterial;
  frame: CardFrame;
  frameColor: CardFrameColor;
  frameEffect: CardFrameEffect;
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
  {
    value: 'infinity',
    label: '无限镜',
    hint: '无限镜面板：两面镜之间的光廊，指针移动时整条光廊的透视跟着位移（创始人专属）',
  },
  {
    value: 'mirror',
    label: '镜面',
    hint: '镀铬镜面板：灯箱与段位色在板面上流动，指针移动时倒角高光跟着扫过（创始人专属）',
  },
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

/** 发丝线 / 双线可选的纯色（rainbow 是流动彩色，不是单一色值） */
export const CARD_FRAME_COLOR_OPTIONS: CardOption<CardFrameColor>[] = [
  { value: 'auto', label: '跟随材质', hint: '沿用当前材质自己的描边色' },
  { value: 'gold', label: '鎏金', hint: '暖金色，最接近原版' },
  { value: 'ice', label: '霜蓝', hint: '冷白偏蓝，安静克制' },
  { value: 'cyan', label: '电青', hint: '高饱和青，像能量轨' },
  { value: 'violet', label: '灵紫', hint: '冷紫，贴合灵能材质' },
  { value: 'rose', label: '霓虹', hint: '偏洋红，亮而不刺' },
  { value: 'emerald', label: '翡翠', hint: '偏绿的冷光' },
  { value: 'rainbow', label: '流动彩色', hint: '整圈色相流动，自带旋转' },
];

export const CARD_FRAME_EFFECT_OPTIONS: CardOption<CardFrameEffect>[] = [
  { value: 'steady', label: '常亮', hint: '保持稳定亮度' },
  { value: 'breathe', label: '呼吸', hint: '缓慢明暗，约 5 秒一轮' },
  { value: 'blink', label: '闪烁', hint: '间断亮灭，像信号灯' },
];

export const DEFAULT_CARD_SKIN: CardSkin = {
  material: 'basic',
  frame: 'hairline',
  frameColor: 'auto',
  frameEffect: 'steady',
};

const MATERIALS = CARD_MATERIAL_OPTIONS.map((option) => option.value);
const FRAMES = CARD_FRAME_OPTIONS.map((option) => option.value);
const FRAME_COLORS = CARD_FRAME_COLOR_OPTIONS.map((option) => option.value);
const FRAME_EFFECTS = CARD_FRAME_EFFECT_OPTIONS.map((option) => option.value);

/** 创始人专属材质：与 @hive/shared 的 FOUNDER_ONLY_MATERIALS 保持一致 */
const FOUNDER_ONLY: CardMaterial[] = ['infinity', 'mirror'];

/** 是不是创始人专属材质（选择器上打角标用；真正的权限在服务端） */
export function isFounderOnlyMaterial(material: CardMaterial): boolean {
  return FOUNDER_ONLY.includes(material);
}

/**
 * 当前身份能选的材质。
 * 只做"藏入口"，真正的权限在 PUT /api/me/card-skin（手搓请求会被 403）。
 */
export function materialOptionsFor(founder: boolean): CardOption<CardMaterial>[] {
  return founder
    ? CARD_MATERIAL_OPTIONS
    : CARD_MATERIAL_OPTIONS.filter((option) => !FOUNDER_ONLY.includes(option.value));
}

/** 只有发丝线和双线有额外的颜色 / 光效选项 */
export function isFrameStyleFrame(frame: CardFrame): frame is 'hairline' | 'double' {
  return frame === 'hairline' || frame === 'double';
}

/** 接口给什么就穿什么；脏值 / 老数据一律回落到默认皮肤，别把卡渲染成空白 */
export function normalizeCardSkin(input?: Partial<CardSkin> | null): CardSkin {
  const pick = <T extends string>(list: T[], value: T | undefined, fallback: T): T =>
    value && list.includes(value) ? value : fallback;
  return {
    material: pick(MATERIALS, input?.material, DEFAULT_CARD_SKIN.material),
    frame: pick(FRAMES, input?.frame, DEFAULT_CARD_SKIN.frame),
    frameColor: pick(FRAME_COLORS, input?.frameColor, DEFAULT_CARD_SKIN.frameColor),
    frameEffect: pick(FRAME_EFFECTS, input?.frameEffect, DEFAULT_CARD_SKIN.frameEffect),
  };
}

/** 「随便换一个」：材质 + 边框 + 配色 + 光效一起换；材质只在 founder 可选的范围内抽 */
export function randomCardSkin(founder = false): CardSkin {
  const pick = <T extends string>(list: T[]): T => list[Math.floor(Math.random() * list.length)] as T;
  const materials = founder ? MATERIALS : MATERIALS.filter((value) => !FOUNDER_ONLY.includes(value));
  return {
    material: pick(materials),
    frame: pick(FRAMES),
    frameColor: pick(FRAME_COLORS),
    frameEffect: pick(FRAME_EFFECTS),
  };
}

/** 取选项文案，找不到就显示原始值（服务端加了新枚举时的兜底） */
export function optionLabel<T extends string>(options: CardOption<T>[], value: T): string {
  return options.find((option) => option.value === value)?.label ?? value;
}
