import { z } from 'zod';

/* ==========================================================================
 * ID
 * ========================================================================== */

/**
 * UUIDv7：前 48 位是毫秒时间戳，其余随机。时间序 → SQLite B+Tree 写入局部性好，
 * 且不像自增 ID 那样泄露社区规模。
 */
export function newId(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  const ts = BigInt(now);
  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70; // version 7
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // RFC 4122 variant

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/* ==========================================================================
 * 错误
 * ========================================================================== */

export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'INVITE_INVALID',
  'POLICY_REQUIRED',
  'RATE_LIMITED',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  INVITE_INVALID: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  POLICY_REQUIRED: 422,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get status(): number {
    return STATUS[this.code];
  }
}

/* ==========================================================================
 * 输入校验
 * ========================================================================== */

/** 用户名一律小写规范化，与数据库的 CHECK (username = lower(username)) 对齐 */
export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, '请填写用户名')
  .regex(/^[a-z0-9_]{3,24}$/, '用户名需 3-24 位，仅限小写字母、数字与下划线');

export const registerSchema = z.object({
  username: usernameSchema,
  displayName: z.string().trim().min(1, '请填写显示名——群里怎么称呼你').max(32, '显示名最多 32 个字'),
  // 空值时同时命中 min 和 email 两条，前端取第一条（「请填写邮箱」）
  email: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, '请填写邮箱')
    .email('邮箱格式不正确，例如 name@example.com'),
  // 空值同样取第一条「请设置密码」，短于 10 位才说长度
  password: z.string().min(1, '请设置密码').min(10, '密码至少 10 位').max(72, '密码最多 72 位'),
  // 邀请码必填：先 trim + 大写化，再按 6–16 位字母/数字/短横线校验。
  // 这些文案与前端 LoginPage 的 RULES 逐字一致——同一个规则别在两处说两种话
  inviteCode: z
    .string()
    .trim()
    .toUpperCase()
    .min(1, '请填写邀请码——由管理员在群里发放')
    .regex(/^[A-Z0-9-]{6,16}$/, '邀请码是 6–16 位字母、数字或短横线，例如 HIVE-DEV-01'),
});

export const loginSchema = z.object({
  identifier: z.string().trim().min(1),
  password: z.string().min(1).max(72),
});

/**
 * 修改密码：新密码规则与注册保持一致（≥10 位）。
 * "新旧密码不能相同"放在路由里判断——它要和当前密码比对，不属于单字段校验。
 */
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(72),
  newPassword: z.string().min(10, '密码至少 10 位').max(72),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

/**
 * 编辑资料（PATCH /api/me）。
 *
 * email 单独拿出来说：它决定"密码找回收信到哪"，所以改邮箱要同时提供当前密码——
 * 只凭一个已登录的会话就能改收件地址，等于把别人的账号接管链路配好了。
 * currentPassword 是否必填由路由按"邮箱有没有变"决定，schema 里只做形状校验。
 */
export const updateProfileSchema = z.object({
  displayName: z.string().trim().min(1, '请填写显示名').max(32, '显示名最多 32 个字').optional(),
  bio: z.string().trim().max(280, '简介最多 280 字').nullable().optional(),
  qqNumber: z
    .string()
    .trim()
    .regex(/^\d{5,12}$/, 'QQ 号应为 5-12 位数字')
    .nullable()
    .optional(),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, '请填写邮箱')
    .email('邮箱格式不正确，例如 name@qq.com')
    .max(254, '邮箱过长')
    .optional(),
  currentPassword: z.string().max(72).optional(),
});

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

/* ==========================================================================
 * 玩家卡片外观（纯展示偏好，不参与评分 / 分队 / 快照）
 *
 * 这四份清单必须与 migrations/0004+ 的 CHECK 一致：
 * SQL 是唯一真源，这里只是给它一个类型化的出口。两者漂移时
 * packages/api/src/card-skin.test.ts 会直接失败。
 * ========================================================================== */

/** 材质：卡片底板的质感，basic = 改造前的默认外观 */
export const CARD_MATERIALS = [
  'basic',
  'pixel',
  'acrylic',
  'sparkle',
  'holo',
  'gold',
  'psi',
  /** 无限镜：两面镜之间的光廊，随指针产生透视位移。**仅创始人可选** */
  'infinity',
  /** 镜面：WebGL2 渲的镜面金属板，环境随倾斜流动。**仅创始人可选** */
  'mirror',
] as const;

/**
 * 创始人专属材质。清单放在 shared 而不是前端：
 * 服务端要用同一份清单拒绝非创始人的提交，两边各写一份迟早漂移。
 */
export const FOUNDER_ONLY_MATERIALS = ['infinity', 'mirror'] as const;

export function isFounderOnlyMaterial(material: string): boolean {
  return (FOUNDER_ONLY_MATERIALS as readonly string[]).includes(material);
}
/** 边框：描边样式 */
export const CARD_FRAMES = [
  'none',
  'hairline',
  'double',
  'corners',
  'bevel',
  'frost',
  'spark',
  'arc',
] as const;

/** 发丝线 / 双线的颜色；rainbow = 流动彩色，效果里自带色相旋转 */
export const CARD_FRAME_COLORS = [
  'auto',
  'gold',
  'ice',
  'cyan',
  'violet',
  'rose',
  'emerald',
  'rainbow',
] as const;

/** 发丝线 / 双线的光效：常亮 / 呼吸 / 闪烁 */
export const CARD_FRAME_EFFECTS = ['steady', 'breathe', 'blink'] as const;

export type CardMaterial = (typeof CARD_MATERIALS)[number];
export type CardFrame = (typeof CARD_FRAMES)[number];
export type CardFrameColor = (typeof CARD_FRAME_COLORS)[number];
export type CardFrameEffect = (typeof CARD_FRAME_EFFECTS)[number];

export const cardSkinSchema = z.object({
  material: z.enum(CARD_MATERIALS),
  frame: z.enum(CARD_FRAMES),
  // 老版本客户端只提交 material / frame 时，按"改造前的样子"补默认值
  frameColor: z.enum(CARD_FRAME_COLORS).default('auto'),
  frameEffect: z.enum(CARD_FRAME_EFFECTS).default('steady'),
});

export type CardSkin = z.infer<typeof cardSkinSchema>;

export const DEFAULT_CARD_SKIN: CardSkin = {
  material: 'basic',
  frame: 'hairline',
  frameColor: 'auto',
  frameEffect: 'steady',
};

/**
 * 把数据库里的四列收成一个对象。老数据 / 脏数据一律回落到默认值——
 * 卡片外观不值得为了一条脏记录把整个报名名单打挂。
 */
export function toCardSkin(input: {
  material?: string | null;
  frame?: string | null;
  frameColor?: string | null;
  frameEffect?: string | null;
}): CardSkin {
  const pick = <T extends string>(list: readonly T[], value: string | null | undefined, fallback: T): T =>
    list.includes(value as T) ? (value as T) : fallback;
  return {
    material: pick(CARD_MATERIALS, input.material, DEFAULT_CARD_SKIN.material),
    frame: pick(CARD_FRAMES, input.frame, DEFAULT_CARD_SKIN.frame),
    frameColor: pick(CARD_FRAME_COLORS, input.frameColor, DEFAULT_CARD_SKIN.frameColor),
    frameEffect: pick(CARD_FRAME_EFFECTS, input.frameEffect, DEFAULT_CARD_SKIN.frameEffect),
  };
}

/* ==========================================================================
 * 常量
 * ========================================================================== */

/** 与数据库 sessions.id 的语义一致：库里只存 token 的 sha256 */
export const SESSION_COOKIE = 'hive_session';
export const CSRF_HEADER = 'x-hive-csrf';
export const CSRF_COOKIE = 'hive_csrf';
