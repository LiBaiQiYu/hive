import envStageUrl from '../assets/env-stage.webp';

/**
 * 镜面卡面（WebGL2）。
 *
 * 参考的是"镀铬金属板"那种观感：板面本身几乎没有颜色，看到的全是**环境**——
 * 灯箱、地平线灯带、段位色的副光，被一个带倒角的曲面反射出来。
 * 所以这里的重点不是"画一个银色渐变"，而是：
 *
 *  1. 法线场：板心朝观察者，靠近板边时**外翻**（倒角），于是边缘会先亮起来，
 *     整块板有"压出来"的厚度感；再叠一层横向拉丝和一层大尺度起伏。
 *  2. 反射：R = reflect(-V, N)。环境是程序化的（没有任何外部素材）：
 *     顶部灯箱、地平线灯带、右侧一条竖灯、左下角一块**段位色**的副光。
 *     主色相由玩家身份 hash 决定，所以每个人的板面冷暖不同。
 *  3. Fresnel（Schlick）：正对时看到的是金属本色，掠射角趋近全反射 → 板边发白。
 *  4. 跟着指针走的一团柔光 + 一点点颗粒，避免"塑料片"的均匀感。
 *
 * 为什么不是直接搬 React Bits 的 ReflectiveCard：
 *  · 那个组件自带 pointermove + rotateX/rotateY，而 HIVE 的倾斜早就由
 *    `.pcard-inner` 的 CSS 3D 做了——两边都转会变成"卡片转一次、板面再转一次"；
 *  · 它的反射源是 `<video>` / 摄像头，而本站 `_headers` 里
 *    `Permissions-Policy: camera=(), microphone=()`，也没有视频素材；
 *  · 一次一张卡开一个 WebGL 上下文，报名页 12 张卡会撞浏览器的上下文上限。
 * 所以这里保留它的**着色思路**，改成一个按需重绘、全站共用一份上下文的渲染器。
 *
 * 性能 / 架构约定：
 *  · **全站只有一个** WebGL2 上下文（离屏 canvas），每帧渲完 drawImage 贴回卡片
 *    自己的 2D canvas。卡片数量不影响上下文数量，`prefers-reduced-motion` 下也不
 *    会有动画循环——只在指针移动 / 尺寸变化时画一帧，和其它五个材质一致。
 *  · WebGL2 不可用（老设备、被策略禁用、上下文丢失）时退回 `paintFallback`，
 *    观感差一档但不会留白。
 *  · 画布按 devicePixelRatio 渲染（上限 2）：镜面有倒角和高频颗粒，
 *    1x 拉伸会把这些细节糊掉。
 */

export interface MirrorOptions {
  /** -1..1，指针横向位置换算的视角（与其它材质同一套约定） */
  tiltX: number;
  /** -1..1，指针纵向位置 */
  tiltY: number;
  /** 玩家标识（userId）：决定环境主色相，同一个人永远是同一个颜色 */
  key?: string;
  /** rank_tier：决定环境副光的颜色 */
  rankTier?: number | null;
  /** 头像地址：会作为场景里的一盏"肖像灯"映进板面（拿不到就不映，不影响其它） */
  avatarUrl?: string | null;
  /** 悬浮量 0..1：柔光只在鼠标在卡上时出现，PlayerCard 会把它缓动后再传进来 */
  hover?: number;
}

export interface MirrorPalette {
  /** 金属本色（sRGB 0..1），Fresnel 的 F0 */
  tint: readonly [number, number, number];
  /** 环境副光：段位色，每个段位不一样 */
  accent: readonly [number, number, number];
}

/** 中性镀铬：几乎是白的，只留一点点冷调 */
const NEUTRAL: readonly [number, number, number] = [0.9, 0.93, 0.97];

/** 段位色（取官方勋章的主色），key 是 rank_tier 的十位 */
const RANK_ACCENTS: Record<number, readonly [number, number, number]> = {
  1: [0.55, 0.58, 0.57],
  2: [0.42, 0.58, 0.62],
  3: [0.74, 0.6, 0.36],
  4: [0.56, 0.44, 0.8],
  5: [0.88, 0.56, 0.22],
  6: [0.26, 0.74, 0.72],
  7: [0.94, 0.8, 0.46],
  8: [0.9, 0.32, 0.4],
};

/** 没填段位时的副光：冷蓝，和站内的信息色同族 */
const DEFAULT_ACCENT: readonly [number, number, number] = [0.5, 0.62, 0.8];

function hslToRgb(hue: number, saturation: number, lightness: number): [number, number, number] {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const sector = ((hue % 360) + 360) % 360 / 60;
  const second = chroma * (1 - Math.abs((sector % 2) - 1));
  let rgb: [number, number, number];
  if (sector < 1) rgb = [chroma, second, 0];
  else if (sector < 2) rgb = [second, chroma, 0];
  else if (sector < 3) rgb = [0, chroma, second];
  else if (sector < 4) rgb = [0, second, chroma];
  else if (sector < 5) rgb = [second, 0, chroma];
  else rgb = [chroma, 0, second];
  const lift = lightness - chroma / 2;
  return [rgb[0] + lift, rgb[1] + lift, rgb[2] + lift];
}

/**
 * 身份 → 0..1 的确定数（FNV-1a）。
 * 用它而不是随机数：同一个人在名单页、个人主页、设置页的预览里必须是同一个颜色，
 * 否则"这张卡是你的"这件事就断了。
 */
export function mirrorSeed(key: string): number {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967296;
}

/** 环境色：金属本色只带一点点玩家色相，副光取段位色（纯函数，便于单测） */
export function mirrorPalette(key: string, rankTier?: number | null): MirrorPalette {
  const hue = mirrorSeed(key) * 360;
  const hueColor = hslToRgb(hue, 0.55, 0.62);
  const tint: [number, number, number] = [
    NEUTRAL[0] + (hueColor[0] - NEUTRAL[0]) * 0.3,
    NEUTRAL[1] + (hueColor[1] - NEUTRAL[1]) * 0.3,
    NEUTRAL[2] + (hueColor[2] - NEUTRAL[2]) * 0.3,
  ];
  const medal = typeof rankTier === 'number' && rankTier > 0 ? Math.floor(rankTier / 10) : 0;
  return { tint, accent: RANK_ACCENTS[medal] ?? DEFAULT_ACCENT };
}

/* ==========================================================================
 * 可调参数（「调整参数」弹窗用）
 *
 * 每一项都直接进着色器 uniform，改完整个站点立刻生效。
 * 存 **localStorage** 而不是数据库：这是调参，不是用户数据。定稿之后应该把
 * DEFAULT_MIRROR_PARAMS 改掉再发版，而不是让线上永远读某个人浏览器里的值。
 * ========================================================================== */

export interface MirrorParams {
  /** 金属度：0 = 哑光（反射几乎没了），1 = 纯金属 */
  metalness: number;
  /**
   * 粗糙度 = **拉丝**（对应参考组件的 roughness）：越大，反射沿"丝"的纹理越明显。
   * 它同时做两件事：微扰反射的纵向取样（把画面拉成横丝）+ 调制亮度。
   */
  roughness: number;
  /** 反射模糊，px（对应 blurStrength）。换算成取样 mip = log2(blur) + 1 */
  blurStrength: number;
  /** 去色：把反射画面压成灰的 */
  grayscale: number;
  /** 表面涟漪（对应 warp）：0 = 完全平直，越大画面被揉得越明显 */
  warp: number;
  /** 涟漪尺度（对应 warpScale）：越大涟漪越粗 */
  warpScale: number;
  /** 扫过去的光带 / 点状高光强度（对应 shine） */
  shine: number;
  /** 倒角宽度，px（对应 bevel） */
  bevel: number;
  /** 跟随指针的柔光（对应 glare） */
  glare: number;
  /** 指针倾斜对反射的增益（参考组件的 tiltStrength 管的是卡片角度，这里管画面位移） */
  tiltGain: number;

  /* ---- 高级：以下都是我们自己加的，默认不用动 ---- */
  /** 场景取样跨度（横向 / 纵向）：越小越"放大" */
  spanX: number;
  spanY: number;
  /** 场景亮度 */
  sceneGain: number;
  /** 肖像灯中心（场景图 uv） */
  spotX: number;
  spotY: number;
  /** 肖像灯半径 */
  spotRadius: number;
  /** 肖像灯混合强度 */
  spotStrength: number;
  /** 头像本身的提亮倍数 */
  avatarGain: number;
  /** 暖色灯罩强度 */
  lampWarm: number;
  /** 板面曲率（只进光照法线，不影响取样） */
  curvX: number;
  curvY: number;
  /** 颗粒（最终抖动） */
  grain: number;
  /** 扫光：光带随卡片倾斜横扫的幅度（0 = 几乎不动） */
  sweep: number;
  /** 高光粗细：那道斜光的半宽（越大越粗） */
  bandWidth: number;
  /** 柔光范围：光晕的大小（越大越散） */
  glareSize: number;
  /** 高光指数（保留位；灯箱光照不用它了） */
  specPower: number;
  /** 曝光 */
  exposure: number;
  /** 倒角亮度 / 板内压暗 */
  rimGain: number;
  bevelShade: number;
}

export const DEFAULT_MIRROR_PARAMS: MirrorParams = {
  // 这一组是用户在调参弹窗里定稿的，别凭感觉改——改之前先看 docs/UI.md §10
  metalness: 1,
  roughness: 0.8,
  blurStrength: 4,
  grayscale: 0,
  warp: 0.15,
  warpScale: 1,
  shine: 0.73,
  /** 0.68：光带横穿大半个卡面，两端还留得住 */
  sweep: 0.68,
  bandWidth: 0.19,
  glareSize: 1,
  bevel: 6,
  glare: 0.36,
  /**
   * 0.13：整条取样跨度是 ±1，再大就像在拖动一张图而不是"板子在晃"
   * （这一项是上一轮和用户一起定下来的，别动）。
   */
  tiltGain: 0.13,

  spanX: 0.5,
  spanY: 0.5,
  sceneGain: 1,
  spotX: 0.2,
  spotY: 0.25,
  spotRadius: 0.155,
  spotStrength: 0.24,
  avatarGain: 3,
  lampWarm: 0.16,
  curvX: 0.3,
  curvY: 0.18,
  grain: 0.02,
  specPower: 700,
  exposure: 1.01,
  rimGain: 0.12,
  bevelShade: 0,
};

/** 每个参数的合法区间：滑块范围与"从 localStorage 读回来时的夹取"共用这一份 */
export const MIRROR_PARAM_RANGES: Record<keyof MirrorParams, readonly [number, number]> = {
  spanX: [0.2, 1],
  spanY: [0.3, 1.3],
  sceneGain: [0.3, 1.6],
  spotX: [0, 1],
  spotY: [0, 1],
  spotRadius: [0.03, 0.3],
  spotStrength: [0, 1.5],
  avatarGain: [0, 5],
  lampWarm: [0, 0.5],
  curvX: [0.1, 0.8],
  curvY: [0, 0.5],
  grain: [0, 0.05],
  tiltGain: [0, 1.5],
  warp: [0, 2],
  warpScale: [0.2, 4],
  metalness: [0, 1],
  roughness: [0, 1],
  blurStrength: [0, 20],
  grayscale: [0, 1],
  shine: [0, 3],
  sweep: [0, 1.5],
  bandWidth: [0.02, 0.25],
  glareSize: [0.3, 3],
  bevel: [0, 16],
  glare: [0, 1],
  specPower: [100, 2000],
  exposure: [0.4, 2],
  rimGain: [0, 2],
  bevelShade: [0, 0.4],
};

const MIRROR_PARAM_KEYS = Object.keys(DEFAULT_MIRROR_PARAMS) as (keyof MirrorParams)[];
const MIRROR_STORAGE_KEY = 'hive-mirror-params';

/** 脏值一律夹到区间里，缺的用默认值——localStorage 是用户可以手改的，别信它 */
export function normalizeMirrorParams(
  input?: Partial<MirrorParams> | null,
): MirrorParams {
  const output = { ...DEFAULT_MIRROR_PARAMS };
  if (!input || typeof input !== 'object') return output;
  for (const key of MIRROR_PARAM_KEYS) {
    const value = input[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    const [min, max] = MIRROR_PARAM_RANGES[key];
    output[key] = Math.min(max, Math.max(min, value));
  }
  return output;
}

function saveMirrorParams(value: MirrorParams): void {
  try {
    globalThis.localStorage?.setItem(MIRROR_STORAGE_KEY, JSON.stringify(value));
  } catch {
    /* 隐私模式 / 配额满：存不下就算了，本次会话内仍然有效 */
  }
}

function loadMirrorParams(): MirrorParams {
  try {
    const raw = globalThis.localStorage?.getItem(MIRROR_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_MIRROR_PARAMS };
    return normalizeMirrorParams(JSON.parse(raw) as Partial<MirrorParams>);
  } catch {
    return { ...DEFAULT_MIRROR_PARAMS };
  }
}

let params: MirrorParams = loadMirrorParams();

export function getMirrorParams(): MirrorParams {
  return { ...params };
}

export function setMirrorParams(next: Partial<MirrorParams>): MirrorParams {
  params = normalizeMirrorParams({ ...params, ...next });
  saveMirrorParams(params);
  return { ...params };
}

export function resetMirrorParams(): MirrorParams {
  params = { ...DEFAULT_MIRROR_PARAMS };
  saveMirrorParams(params);
  return { ...params };
}

/* ==========================================================================
 * 素材：场景图 + 头像
 *
 * 两张都是异步就绪：没就绪就继续用程序化环境，绝不阻塞首帧。
 *  · 场景图是本地打包的 webp（1024×576，16KB），同源，不需要 CORS。
 *  · 头像来自 Steam CDN，**另开一个 Image 并设 crossOrigin='anonymous'**：
 *    avatars.steamstatic.com 带 `Access-Control-Allow-Origin: *`（实测过），
 *    所以能直接当纹理；万一某个主机不带头，onerror 静默失败，只是少了那盏灯。
 *    **绝不能给卡片上显示用的 <img> 加 crossorigin**——那会让整张头像消失。
 * ========================================================================== */

/** 反射里只要 64px 的 _medium 版本（2.6KB）；卡面上显示的那张照旧用 _full */
function mediumAvatarUrl(url: string): string {
  return url.replace(/_full\.(jpe?g|png)$/i, '_medium.$1');
}

let sceneImage: HTMLImageElement | null = null;
let sceneState: 'idle' | 'loading' | 'ready' | 'failed' = 'idle';
let sceneWait: Promise<void> | null = null;

/** 已经有结果的头像地址（成功或失败）：用来判断还要不要等 */
const avatarSettled = new Set<string>();
const avatarImages = new Map<string, HTMLImageElement>();
const avatarWaiting = new Map<string, Promise<void>>();

function startScene(): void {
  if (sceneState !== 'idle') return;
  sceneState = 'loading';
  const image = new Image();
  sceneWait = new Promise<void>((resolve) => {
    image.onload = () => {
      sceneImage = image;
      sceneState = 'ready';
      resolve();
    };
    image.onerror = () => {
      sceneState = 'failed';
      resolve();
    };
  });
  image.src = envStageUrl;
}

function startAvatar(url: string): void {
  if (avatarSettled.has(url) || avatarWaiting.has(url)) return;
  const image = new Image();
  image.crossOrigin = 'anonymous';
  const wait = new Promise<void>((resolve) => {
    const settle = (loaded: boolean) => {
      if (loaded) avatarImages.set(url, image);
      avatarSettled.add(url);
      avatarWaiting.delete(url);
      resolve();
    };
    image.onload = () => settle(true);
    image.onerror = () => settle(false);
  });
  avatarWaiting.set(url, wait);
  image.src = mediumAvatarUrl(url);
}

/**
 * 预热素材。已经就绪（或已经失败过）时返回 null ——
 * 调用方只在这上面做一件事：拿到 Promise 就在它 resolve 之后重画一帧。
 */
export function ensureMirrorAssets(avatarUrl?: string | null): Promise<void> | null {
  startScene();
  if (avatarUrl) startAvatar(avatarUrl);

  const waits: Promise<void>[] = [];
  if (sceneState === 'loading' && sceneWait) waits.push(sceneWait);
  if (avatarUrl && !avatarSettled.has(avatarUrl)) {
    const wait = avatarWaiting.get(avatarUrl);
    if (wait) waits.push(wait);
  }
  if (!waits.length) return null;
  return Promise.all(waits).then(() => undefined);
}

/* ==========================================================================
 * 着色器
 * ========================================================================== */

const VERTEX_SHADER = `#version 300 es
in vec2 aPos;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
out vec4 fragColor;

uniform vec2 uRes;    // 画布像素尺寸
uniform vec2 uTilt;   // -1..1，指针位置
uniform vec3 uTint;   // 金属本色（F0）
uniform vec3 uAccent; // 段位色：程序化环境里左下角那块副光
uniform sampler2D uScene;  // 场景图（sRGB，硬件转线性）
uniform sampler2D uAvatar; // 本人头像（sRGB）
uniform vec2 uEnvReady;    // x: 场景图就绪, y: 头像就绪
// 可调参数（「调整参数」弹窗）。打包成 vec4 是为了少传几次 uniform，
// 每一项对应 MirrorParams 里的一个字段，注释写清了顺序。
uniform vec4 uEnvCfg;   // x 横向跨度 y 纵向跨度 z 取样 mip（由 blurStrength 折算） w 场景亮度
uniform vec4 uSpotCfg;  // xy 灯中心(uv) z 半径 w 强度
uniform vec4 uMisc;     // x 头像提亮 y 暖光强度 z 涟漪(warp) w 粗糙度(拉丝)
uniform vec4 uMisc2;    // x 金属度 y 去色 z 涟漪尺度 w 保留
uniform vec4 uSurface;  // x 横向曲率 y 纵向曲率 z 保留 w 颗粒
uniform vec4 uLightCfg; // x 高光指数 y 高光强度(shine) z 指针柔光 w 曝光
uniform vec4 uRimCfg;   // x 倒角宽度(px) y 倒角亮度 z 板内压暗 w 倾斜增益
uniform vec4 uLight2;   // x 高光粗细(w) y 柔光范围 z 保留 w 保留

// 便宜的确定性噪声。镜面的细节频率不高，用不上贴图。
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// 程序化环境（无图时的兜底）：一间只有灯的黑屋子。金属反射什么，看到的就是什么。
// 关键不是"灯有多亮"，而是**边界有多硬**——软光斑反射上去就成了雾气。
// 镜面感的核心就是那条"地平线"：亮天花板与暗地面之间一道几乎不模糊的分界，
// 它在板面上斜着穿过去，一眼就能认出是金属。
vec3 proceduralEnvironment(vec3 R) {
  // 整体转 30°：正的横纹像百叶窗，斜着穿过去才像摄影棚里的灯箱
  vec2 q = mat2(0.87, 0.50, -0.50, 0.87) * R.xy;

  // 亮天花板 / 暗地面，中间一条硬地平线（过渡只有板面宽的 2% 左右）
  vec3 col = mix(
    vec3(0.006, 0.008, 0.011),
    vec3(0.86, 0.90, 0.98),
    smoothstep(-0.012, 0.012, q.y)
  );
  // 天花板越往上越暗一点，免得亮面是一块死板的纯色
  col *= mix(1.0, 0.74, smoothstep(0.0, 1.0, q.y));

  // 硬边窗：一块有明确边界的反光区，金属上最"铬"的那一下。
  // feather 必须很小——0.05 就会变成一片雾。
  vec2 d2 = abs(q - vec2(-0.62, 0.10)) - vec2(0.22, 0.34);
  float box2 = 1.0 - smoothstep(-0.010, 0.010, length(max(d2, 0.0)) + min(max(d2.x, d2.y), 0.0));
  col += vec3(0.96, 0.98, 1.0) * box2 * 0.55;

  // 细灯条：在板面上拉出一道锐利的高光线
  col += vec3(1.0) * exp(-pow((q.x - 0.70) * 26.0, 2.0)) * 0.90;
  // 第二道更细的灯丝，落在另一侧，形成交叉
  col += vec3(0.98, 0.99, 1.0) * exp(-pow((q.y - 0.52) * 30.0, 2.0)) * 0.55;

  // 左下副光：段位色，每张卡唯一的一块颜色。要窄——铺开就变成"整块板偏棕"，
  // 那是另一种金色材质，不是镜面。
  col += uAccent * exp(-pow((q.x + 0.62) * 3.2, 2.0) - pow((q.y + 0.50) * 4.0, 2.0)) * 0.85;

  return col;
}

// 真实场景反射：取样坐标由 main() 算好传进来。
//
// 为什么角度不能直接从法线来：一张**平面**镜按方向取样，整块板映到的是同一个
// 方向 → 一片纯色。想看见画面就必须让方向随位置变，也就是让板面"弯"——而这
// 正是画面扭曲的来源。所以这里把取样拆成两截：
//   线性窗口（屏幕位置 × 缩放 + 指针平移）= 平面镜 + 远处一面墙，**零形变**；
//   弯曲项（曲面法线给出的方向）= 现在的鼓形效果。
// 两者按 uMisc.z（画面形变）混合，拉到 0 就是完全平直的画面。
vec3 sceneEnvironment(vec2 uvScene) {
  vec2 uv = clamp(uvScene, 0.002, 0.998);
  // 取高 mip：金属映出来的是"远处的屋子"，本来就该是虚的。
  // 清晰的原图反而像贴纸，而且和卡片上的文字抢对比度（踩过）。
  vec3 col = textureLod(uScene, uv, uEnvCfg.z).rgb * uEnvCfg.w;
  // 去色只作用于**场景照片**，不能作用于下面那盏肖像灯——
  // 灯是这个材质里唯一的暖色，去色会把"你"直接洗成灰色（踩过）。
  col = mix(col, vec3(dot(col, vec3(0.299, 0.587, 0.114))), uMisc2.y);

  // 房间里的那盏"肖像灯"：把本人头像当成一块发光的画挂进场景。
  // 挂在场景图的一片树林里，和暖色天光混在一起——换背景图时要重新找 spot 位置。
  if (uEnvReady.y > 0.5) {
    vec2 local = (uv - uSpotCfg.xy) / uSpotCfg.z;
    float d = length(local);
    float mask = 1.0 - smoothstep(0.62, 1.0, d);
    vec3 av = textureLod(uAvatar, clamp(local * 0.5 + 0.5, 0.002, 0.998), 1.6).rgb;
    // 用 max 而不是直接替换：头像大多偏暗，直接盖上去会在板面上砸出一个黑洞。
    // 只允许它"提亮"，这样它才像一盏灯，而不是一张贴上去的图。
    vec3 lamp = max(col, av * av * uMisc.x + av * 0.55 + vec3(0.02, 0.04, 0.09));
    col = mix(col, lamp, mask * uSpotCfg.w);
    // 暖色灯罩：整间屋子都是冷蓝的，唯一一处暖光就是"你"——这也是全局里
    // 唯一能让人一眼找到头像的线索，别改成冷色。
    col += vec3(1.0, 0.72, 0.36) * exp(-d * d * 2.2) * uMisc.y;
  }
  return col;
}

vec3 environment(vec3 R, vec2 uvScene) {
  return uEnvReady.x > 0.5 ? sceneEnvironment(uvScene) : proceduralEnvironment(R);
}

// 柔边条带 / 灯箱：从参考组件的 PLATE 那几支搬过来的（erf 收边的解析式光带）。
// 比"hdv 高次幂"更像照片里的反光板：一条有宽度的斜光，扫过时能把丝纹照出来。
float erfA(float x) {
  float x2 = x * x;
  return sign(x) * sqrt(1.0 - exp(-x2 * (1.2732395 + 0.147 * x2) / (1.0 + 0.147 * x2)));
}

float bandA(float x, float halfWidth, float sigma) {
  float s = 1.4142136 * max(sigma, 0.0001);
  return 0.5 * (erfA((x + halfWidth) / s) - erfA((x - halfWidth) / s));
}

float stripA(vec2 q, vec2 center, vec2 dir, float halfWidth, vec2 sigma) {
  vec2 normal = vec2(-dir.y, dir.x);
  return bandA(dot(q - center, normal), halfWidth, length(sigma * normal));
}

/**
 * 灯箱：**只有一道斜光**。
 * 卡面上看到的那条亮带，就是一块反光板映在金属表面上的像——
 * 不需要顶光 / 侧光，多一条就会变成"好几个光源"，不像真实的一间屋子。
 * 半宽 0.075（比参考组件的 0.022 粗三倍多），因为它是一条"有宽度的反光"，
 * 不是一道锐利的高光线。
 */
float softbox(vec2 q, vec2 sigma, float halfWidth) {
  return stripA(q, vec2(-0.1, -0.16), normalize(vec2(0.5, 0.86)), halfWidth, sigma + 0.03);
}

/** 没有场景图时的"房间"：参考组件 room() 的灰底版本 */
float room(float y, vec2 q, vec2 sigma) {
  float fall = smoothstep(-0.55, 0.5, y);
  float flag = stripA(q, vec2(0.24, -0.02), normalize(vec2(0.5, 0.86)), 0.09, sigma + 0.08);
  return mix(0.85, 0.12, fall) * (1.0 - 0.6 * flag);
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float aspect = uRes.x / max(uRes.y, 1.0);

  // 板面坐标：纵向归一，横向按宽高比拉伸 → 曲率和倒角在屏幕上是等宽的
  vec2 halfSize = vec2(aspect, 1.0);
  vec2 p = (uv * 2.0 - 1.0) * halfSize;
  vec2 radial = p / halfSize; // -1..1，用来算"离边缘多远"

  // 法线：一块微微弯起来的金属板。注意这里只是**几何**法线，
  // 拉丝/抛光那两层纹理扰动另算（见下面 Nlit）——它们不该参与反射取样。
  vec3 N = normalize(vec3(p.x * uSurface.x, p.y * uSurface.y, 1.0));

  // 视线方向：**x 要取反**。V 是"从板面指向观察者"的方向，而卡片向右倾时
  // 板面法线是朝右的，反射应该映到场景的右侧。直接用 +uTilt.x 会让整张反射
  // 往反方向跑（用户报过）。这里的 V 只给高光和 Fresnel 用，取样坐标见下。
  vec3 V = normalize(vec3(-uTilt.x * uRimCfg.w, uTilt.y * uRimCfg.w, 1.0));
  float ndv = clamp(dot(N, V), 0.0, 1.0);
  vec3 R = reflect(-V, N);

  /* ---------------------------------------------------------------- 金属丝
     参考组件里"拉丝"= roughness：三档 valueNoise 沿 **y 高频、x 低频** 叠起来，
     在板面上就是极细的横丝。它做两件事：
       ① 微扰反射的纵向取样 → 画面被拉成横丝（这就是"金属拉丝"的观感来源）；
       ② 调制亮度。
     系数都压得很小：丝是"质感"，不是"扭曲"。 */
  float grain = vnoise(vec2(gl_FragCoord.x * 0.008, gl_FragCoord.y * 0.55)) * 0.45
              + vnoise(vec2(gl_FragCoord.x * 0.019 + 3.7, gl_FragCoord.y * 0.23)) * 0.35
              + vnoise(vec2(gl_FragCoord.x * 0.004 + 9.2, gl_FragCoord.y * 0.09)) * 0.2;
  float brush = uMisc.w * uMisc.w;

  /* ---------------------------------------------------------------- 取样坐标
     一条公式，全部可调，**和法线无关**——之前把取样挂在曲面法线上，结果
     曲率既是"画面有内容"的唯一来源、又是"画面扭曲"的唯一来源，两个诉求打架，
     怎么调都调不到不扭曲。

     q     板面坐标，y 翻成"图像向下"（纹理 v 朝下：card top ↔ image top）
     warp  表面涟漪（对应参考组件的 warp）：0 = 完全平直
     slide 窗口跟着指针平移 → 画面反向移动。x、y 同号：指针往右，画面往左；
           指针往下，画面往上。这和卡片视差层（--px * -18px）是同一套约定。
           **这套方向是上一轮和用户一起定下来的，别动。** */
  vec2 q = vec2(radial.x, -radial.y);
  vec2 slide = vec2(uTilt.x, uTilt.y) * uRimCfg.w;
  vec2 uvScene = 0.5 + (q * 0.85 + slide) * uEnvCfg.xy;

  // 表面涟漪：低频噪声，越大画面被揉得越明显
  vec2 wp = gl_FragCoord.xy / (220.0 * uMisc2.z);
  vec2 ripple = (vec2(vnoise(wp), vnoise(wp + 37.0)) - 0.5) * uMisc.z;
  uvScene += ripple * 0.02;

  // 丝：只沿纵向微扰 → 画面被拉成横丝（幅度很小，不会把竖线拧弯）
  uvScene.y += (grain - 0.5) * brush * 0.05;

  // Fresnel：正对时是金属本色，掠射趋近全反射
  vec3 F = uTint + (1.0 - uTint) * pow(1.0 - ndv, 5.0);
  vec3 col = environment(R, uvScene) * F;

  // 金属度：0 = 哑光（反射几乎没了，只剩底色），1 = 纯金属
  col = mix(vec3(0.02) + uTint * 0.10, col, uMisc2.x);
  // 去色：只有"没有场景图"那条兜底路径才在 main 里补一次
  // （有场景图时已经在 sceneEnvironment 里对照片做过，灯要保留颜色）
  if (uEnvReady.x < 0.5) {
    col = mix(col, vec3(dot(col, vec3(0.299, 0.587, 0.114))), uMisc2.y);
  }
  // 丝的亮度调制（参考组件：scene *= 1 + (grain-0.5)*brush*0.3）
  col *= 1.0 + (grain - 0.5) * brush * 0.35;

  /* ---------------------------------------------------------------- 灯箱光照
     按参考组件实现：**不是点状高光，是一条有宽度的反光板**。
     qDir = R.xy / R.z 是"反射方向"，灯箱在这张方向图上刻出斜光 / 顶光 / 侧光；
     sigma 让光带边缘随模糊、丝纹扩散——所以光带扫过时能把丝纹照出来。
     柔光（glare）**只在鼠标悬浮时出现**（uMisc2.w = 0..1 的悬浮量）。 */
  vec2 qDir = R.xy / max(R.z, 0.2);
  vec2 footprint = fwidth(qDir);
  float blurNorm = uSurface.z / 900.0;
  vec2 sigma = sqrt(
    vec2(blurNorm) * vec2(blurNorm) + footprint * footprint * 0.5
  ) + vec2(0.004, 0.05) * uMisc.w;

  // 光带的位移：**单独给一个大增益**。反光板映在卡面上的像会随卡片角度大幅扫过，
  // 只靠法线曲面那点位移是不够的（那样几乎看不出在动）。方向与 V 一致（x 取反）。
  vec2 lightQ = qDir + vec2(-uTilt.x, uTilt.y) * uLightCfg.x;
  float soft = softbox(lightQ, sigma, uLight2.x);

  vec2 toPointer = vec2(uTilt.x, -uTilt.y) * 1.6 / max(uLight2.y, 0.05);
  vec2 spread = toPointer * vec2(1.0, 1.0 / (1.0 + 2.5 * uMisc.w));
  float reach = dot(spread, spread);
  float glint = max(1.0 + 3.0 * dot(N.xy, toPointer), 0.0);
  float glare =
      (exp(-reach * 1.6) + exp(-reach * 0.35) * 0.15) * glint * uLightCfg.z * uMisc2.w;

  // 高光乘上丝纹：这就是"高光把拉丝质感透露出来"的那一步
  float highlight = (soft * uLightCfg.y + glare) * mix(0.4, 1.0, uMisc2.x);
  highlight *= 1.0 + (grain - 0.5) * brush * 1.8;
  col += uTint * highlight * 0.55;

  // 没有场景图时，用参考组件的灰底房间兜底（叠在反射上面）
  if (uEnvReady.x < 0.5) {
    col = mix(col, uTint * room(qDir.y, qDir, sigma), 0.85);
  }

  // 倒角：紧贴边内侧压一道，再在倒角面上按光来的方向补一记亮线。
  // 有方向的倒角才像压出来的钢板；四边等亮的圆环只会像描边。
  // uRimCfg.x 现在是**倒角宽度（px）**，换算成"离边缘多近"的阈值。
  float edgeDist = max(abs(radial.x), abs(radial.y));
  float bevelT = clamp(uRimCfg.x / (0.5 * min(uRes.x, uRes.y)), 0.0, 1.0);
  float rimMask = bevelT > 0.002 ? smoothstep(1.0 - bevelT, 1.0, edgeDist) : 0.0;
  vec2 outward = normalize(p + vec2(1e-4));
  float rimLight = clamp(dot(outward, normalize(vec2(-0.55, 0.84))), 0.0, 1.0);
  col *= mix(1.0 - uRimCfg.z, 1.0, smoothstep(0.0, 0.20, edgeDist));
  col += (uTint * 0.6 + vec3(0.4)) * rimMask * (0.08 + uRimCfg.y * rimLight);

  // 顶亮底暗：板子是被上方灯照着的
  col *= mix(0.92, 1.04, uv.y);

  // 颗粒：绝对光滑的镜面看着像塑料
  col += (hash21(gl_FragCoord.xy) - 0.5) * uSurface.w;

  // 色调映射 + gamma：避免灯带处整片死白
  col = vec3(1.0) - exp(-col * uLightCfg.w);
  fragColor = vec4(pow(col, vec3(1.0 / 2.2)), 1.0);
}
`;

/* ==========================================================================
 * 渲染器（全站共用一份上下文）
 * ========================================================================== */

interface GlState {
  gl: WebGL2RenderingContext;
  canvas: HTMLCanvasElement;
  program: WebGLProgram;
  res: WebGLUniformLocation | null;
  tilt: WebGLUniformLocation | null;
  tint: WebGLUniformLocation | null;
  accent: WebGLUniformLocation | null;
  scene: WebGLUniformLocation | null;
  avatar: WebGLUniformLocation | null;
  envReady: WebGLUniformLocation | null;
  envCfg: WebGLUniformLocation | null;
  spotCfg: WebGLUniformLocation | null;
  misc: WebGLUniformLocation | null;
  misc2: WebGLUniformLocation | null;
  light2: WebGLUniformLocation | null;
  surface: WebGLUniformLocation | null;
  lightCfg: WebGLUniformLocation | null;
  rimCfg: WebGLUniformLocation | null;
  /** 没图时占位用的 1×1 黑纹理，免得采样到"不完整纹理" */
  blank: WebGLTexture | null;
}

let state: GlState | null = null;
/** WebGL2 这条路彻底不可用（创建失败 / 上下文丢失）：本页后续一律走 2D 回退 */
let unusable = false;

/** 纹理：场景图一张 + 头像按 URL 缓存（上限 6，够一屏卡片来回悬停用） */
let sceneTexture: WebGLTexture | null = null;
const avatarTextures = new Map<string, WebGLTexture>();
const AVATAR_TEXTURE_LIMIT = 6;

/**
 * 上传一张图当纹理。
 * 用 SRGB8_ALPHA8 内部格式：采样时硬件转成线性，和 main() 末尾的
 * tonemap + gamma 正好对上——不转的话整张场景会发灰发白。
 */
function uploadTexture(gl: WebGL2RenderingContext, image: TexImageSource): WebGLTexture | null {
  const texture = gl.createTexture();
  if (!texture) return null;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, image);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}

/** 取出（必要时上传）某个玩家的头像纹理；LRU 超限时删掉最早的那张 */
function avatarTextureFor(gl: WebGL2RenderingContext, url: string): WebGLTexture | null {
  const cached = avatarTextures.get(url);
  if (cached) return cached;
  const image = avatarImages.get(url);
  if (!image) return null;
  const texture = uploadTexture(gl, image);
  if (!texture) return null;
  avatarTextures.set(url, texture);
  if (avatarTextures.size > AVATAR_TEXTURE_LIMIT) {
    const oldest = avatarTextures.keys().next();
    if (!oldest.done) {
      const evicted = avatarTextures.get(oldest.value);
      if (evicted) gl.deleteTexture(evicted);
      avatarTextures.delete(oldest.value);
    }
  }
  return texture;
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
  gl.deleteShader(shader);
  return null;
}

function createState(): GlState | null {
  if (typeof document === 'undefined' || unusable) return null;

  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    // 渲完要立刻 drawImage 贴到卡片自己的 2D canvas 上，画完这一帧之前不能丢内容
    preserveDrawingBuffer: true,
    powerPreference: 'low-power',
  });
  if (!gl) {
    unusable = true;
    return null;
  }

  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  const program = vertex && fragment ? gl.createProgram() : null;
  if (!vertex || !fragment || !program) {
    unusable = true;
    return null;
  }
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    unusable = true;
    return null;
  }
  gl.useProgram(program);

  // 一个覆盖整个视口的三角形（比两个三角形少一条对角线接缝）
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, 'aPos');
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

  // 上下文丢了就整页退回 2D：重建一次再丢的概率不低，反复试只会闪
  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    state = null;
    unusable = true;
  });

  return {
    gl,
    canvas,
    program,
    res: gl.getUniformLocation(program, 'uRes'),
    tilt: gl.getUniformLocation(program, 'uTilt'),
    tint: gl.getUniformLocation(program, 'uTint'),
    accent: gl.getUniformLocation(program, 'uAccent'),
    scene: gl.getUniformLocation(program, 'uScene'),
    avatar: gl.getUniformLocation(program, 'uAvatar'),
    envReady: gl.getUniformLocation(program, 'uEnvReady'),
    envCfg: gl.getUniformLocation(program, 'uEnvCfg'),
    spotCfg: gl.getUniformLocation(program, 'uSpotCfg'),
    misc: gl.getUniformLocation(program, 'uMisc'),
    misc2: gl.getUniformLocation(program, 'uMisc2'),
    light2: gl.getUniformLocation(program, 'uLight2'),
    surface: gl.getUniformLocation(program, 'uSurface'),
    lightCfg: gl.getUniformLocation(program, 'uLightCfg'),
    rimCfg: gl.getUniformLocation(program, 'uRimCfg'),
    blank: (() => {
      const texture = gl.createTexture();
      if (!texture) return null;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        1,
        1,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        new Uint8Array([0, 0, 0, 255]),
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return texture;
    })(),
  };
}

/**
 * 2D 回退：没有 WebGL2 时也得是"同一间屋子"，别留一块空白。
 * 有场景图就铺图 + 画肖像灯；没有才退回渐变（比逐像素光照便宜得多，
 * 这一类设备本来也吃不动）。
 */
function paintFallback(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  { tiltX, tiltY, avatarUrl }: MirrorOptions,
  { tint, accent }: MirrorPalette,
): void {
  if (sceneImage) {
    const sw = sceneImage.naturalWidth || 1;
    const sh = sceneImage.naturalHeight || 1;
    const imageRatio = sh / sw;
    let dw = w;
    let dh = w * imageRatio;
    if (dh < h) {
      dh = h;
      dw = h / imageRatio;
    }
    // 按倾斜平移一点：方向和 shader 里一致（指针往右，画面往左）
    const ox = (w - dw) * 0.5 - tiltX * (dw - w) * 0.22;
    const oy = (h - dh) * 0.5 - tiltY * (dh - h) * 0.22;
    ctx.drawImage(sceneImage, ox, oy, dw, dh);

    // 肖像灯：位置直接从参数换到卡面坐标，不追求和 shader 完全一致，够像就行
    const avatar = avatarUrl ? avatarImages.get(avatarUrl) : undefined;
    const x = w * params.spotX - tiltX * w * 0.05;
    const y = h * (1 - params.spotY) - tiltY * h * 0.05;
    const radius = h * params.spotRadius * 1.6;
    const halo = ctx.createRadialGradient(x, y, radius * 0.5, x, y, radius * 2.4);
    halo.addColorStop(0, 'rgba(120, 170, 255, 0.26)');
    halo.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, w, h);
    if (avatar) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.clip();
      ctx.filter = 'blur(2px)';
      ctx.globalAlpha = 0.9;
      ctx.drawImage(avatar, x - radius, y - radius, radius * 2, radius * 2);
      ctx.restore();
    }
    return;
  }

  const toRgb = (color: readonly [number, number, number], alpha = 1): string =>
    `rgba(${Math.round(color[0] * 255)}, ${Math.round(color[1] * 255)}, ${Math.round(
      color[2] * 255,
    )}, ${alpha})`;

  const base = ctx.createLinearGradient(0, 0, w, h);
  base.addColorStop(0, '#0c1017');
  base.addColorStop(0.52, toRgb(tint, 0.5));
  base.addColorStop(1, '#080b11');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, w, h);

  // 环境里那块主光箱：跟着倾斜反向位移，模拟反射扫过
  const glow = ctx.createRadialGradient(
    w * (0.32 - tiltX * 0.16),
    h * (0.3 - tiltY * 0.16),
    0,
    w * 0.4,
    h * 0.36,
    Math.max(w, h) * 0.72,
  );
  glow.addColorStop(0, toRgb(tint, 0.72));
  glow.addColorStop(0.42, toRgb(tint, 0.16));
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);

  // 地平线灯带
  const band = ctx.createLinearGradient(0, h * 0.28, 0, h * 0.62);
  band.addColorStop(0, 'rgba(230,240,255,0)');
  band.addColorStop(0.48, 'rgba(230,240,255,0.42)');
  band.addColorStop(1, 'rgba(230,240,255,0)');
  ctx.fillStyle = band;
  ctx.fillRect(0, h * 0.24, w, h * 0.42);

  // 段位色副光
  const flare = ctx.createRadialGradient(
    w * (0.18 + tiltX * 0.1),
    h * (0.82 + tiltY * 0.08),
    0,
    w * 0.2,
    h * 0.84,
    Math.max(w, h) * 0.5,
  );
  flare.addColorStop(0, toRgb(accent, 0.5));
  flare.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = flare;
  ctx.fillRect(0, 0, w, h);
}

/**
 * 压暗 / 暗角。镜面本身可以很亮，但卡片上要压文字——
 * 这一层是"可读性"的保底，和 infinity.ts 的 scrim 是同一个理由。
 */
function paintScrims(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  // 整体只压一档：压太狠金属就没反差了，文字的保底交给下面两条渐变和描边
  ctx.fillStyle = 'rgba(6, 10, 16, 0.14)';
  ctx.fillRect(0, 0, w, h);

  const vignette = ctx.createRadialGradient(
    w * 0.5,
    h * 0.44,
    0,
    w * 0.5,
    h * 0.44,
    Math.max(w, h) * 0.9,
  );
  vignette.addColorStop(0, 'rgba(4, 7, 12, 0)');
  vignette.addColorStop(0.72, 'rgba(4, 7, 12, 0.08)');
  vignette.addColorStop(1, 'rgba(3, 5, 9, 0.30)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, w, h);

  // 顶部（名字 / 徽标）与底部（正选 / 候补）各压一段，保证小字也读得清。
  // 这两条是"字压在金属上也认得出来"的保底，别再压重——压重了整块板就灰了。
  const top = ctx.createLinearGradient(0, 0, 0, h * 0.32);
  top.addColorStop(0, 'rgba(3, 5, 9, 0.52)');
  top.addColorStop(1, 'rgba(3, 5, 9, 0)');
  ctx.fillStyle = top;
  ctx.fillRect(0, 0, w, h * 0.32);

  const bottom = ctx.createLinearGradient(0, h * 0.68, 0, h);
  bottom.addColorStop(0, 'rgba(3, 5, 9, 0)');
  bottom.addColorStop(1, 'rgba(3, 5, 9, 0.54)');
  ctx.fillStyle = bottom;
  ctx.fillRect(0, h * 0.68, w, h * 0.32);
}

/**
 * 画一帧镜面卡面。签名和其它材质一致（canvas + CSS 尺寸 + 倾角），
 * 多出来的是"这是谁的卡"——环境色相由它决定。
 */
export function renderMirrorFrame(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  options: MirrorOptions,
): void {
  // 倒角和高频颗粒在 1x 拉伸后会糊成一片，按 DPR 渲染；上限 2 是给显存留余地
  const ratio = Math.min(2, Math.max(1, globalThis.devicePixelRatio || 1));
  const w = Math.max(2, Math.round(width * ratio));
  const h = Math.max(2, Math.round(height * ratio));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const palette = mirrorPalette(options.key ?? '', options.rankTier);
  // 悬浮量：只在鼠标在卡上时才有柔光（参考组件也是 hover 才亮）
  const hover = Math.min(1, Math.max(0, options.hover ?? 0));
  if (!state) state = createState();

  const glState = state;
  if (glState) {
    const { gl } = glState;
    if (glState.canvas.width !== w || glState.canvas.height !== h) {
      glState.canvas.width = w;
      glState.canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.useProgram(glState.program);
    gl.uniform2f(glState.res, w, h);
    gl.uniform2f(glState.tilt, options.tiltX, options.tiltY);
    gl.uniform3f(glState.tint, palette.tint[0], palette.tint[1], palette.tint[2]);
    gl.uniform3f(glState.accent, palette.accent[0], palette.accent[1], palette.accent[2]);

    // 素材纹理：挂载后第一次渲染时上传，之后复用；没就绪就绑占位纹理
    if (!sceneTexture && sceneState === 'ready' && sceneImage) {
      sceneTexture = uploadTexture(gl, sceneImage);
    }
    const avatarUrl = options.avatarUrl;
    const avatarTexture = avatarUrl ? avatarTextureFor(gl, avatarUrl) : null;

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sceneTexture ?? glState.blank);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, avatarTexture ?? glState.blank);
    gl.uniform1i(glState.scene, 0);
    gl.uniform1i(glState.avatar, 1);
    gl.uniform2f(glState.envReady, sceneTexture ? 1 : 0, avatarTexture ? 1 : 0);

    // 可调参数（「调整参数」弹窗改的就是这一组）
    // blurStrength(px) → 取样 mip。参考组件是把 env 画小再模糊（env 宽度 ∝ 1/blur），
    // 这里等价地取 mip = log2(blur)：blur 6 → 2.6 级（环境约 170px），够软但不糊。
    const lod = Math.min(6, Math.max(0, Math.log2(Math.max(1, params.blurStrength))));
    gl.uniform4f(glState.envCfg, params.spanX, params.spanY, lod, params.sceneGain);
    gl.uniform4f(
      glState.spotCfg,
      params.spotX,
      params.spotY,
      params.spotRadius,
      params.spotStrength,
    );
    gl.uniform4f(glState.misc, params.avatarGain, params.lampWarm, params.warp, params.roughness);
    gl.uniform4f(glState.misc2, params.metalness, params.grayscale, params.warpScale, hover);
    gl.uniform4f(glState.surface, params.curvX, params.curvY, params.blurStrength, params.grain);
    gl.uniform4f(glState.lightCfg, params.sweep, params.shine, params.glare, params.exposure);
    gl.uniform4f(glState.light2, params.bandWidth, params.glareSize, 0, 0);
    gl.uniform4f(
      glState.rimCfg,
      params.bevel * ratio,
      params.rimGain,
      params.bevelShade,
      params.tiltGain,
    );

    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // 同一帧内贴回去：preserveDrawingBuffer 保证这里读得到刚画的内容
    ctx.drawImage(glState.canvas, 0, 0, w, h);
  } else {
    paintFallback(ctx, w, h, options, palette);
  }

  paintScrims(ctx, w, h);
}
