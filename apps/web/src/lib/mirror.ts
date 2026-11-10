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
uniform vec3 uAccent; // 段位色：环境里左下角那块副光

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

// 程序化环境：一间只有灯的黑屋子。金属反射什么，看到的就是什么。
// 关键不是"灯有多亮"，而是**边界有多硬**——软光斑反射上去就成了雾气。
// 镜面感的核心就是那条"地平线"：亮天花板与暗地面之间一道几乎不模糊的分界，
// 它在板面上斜着穿过去，一眼就能认出是金属。
vec3 environment(vec3 R) {
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

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float aspect = uRes.x / max(uRes.y, 1.0);

  // 板面坐标：纵向归一，横向按宽高比拉伸 → 曲率和倒角在屏幕上是等宽的
  vec2 halfSize = vec2(aspect, 1.0);
  vec2 p = (uv * 2.0 - 1.0) * halfSize;
  vec2 radial = p / halfSize; // -1..1，用来算"离边缘多远"

  // 法线：一块微微弯起来的金属板（横向曲率略大于纵向），
  // 曲率要够大，倾斜时反射才会整片扫过去，而不是只在原地闪一下。
  vec3 N = normalize(vec3(p.x * 0.44, p.y * 0.34, 1.0));
  // 拉丝：低频横纹，只给一点点扰动（高频噪声在 1x 下就是砂纸）
  N.xy += vec2(sin(p.y * 24.0 + p.x * 1.4) * 0.010, 0.0);
  // 曲面上的细微不均匀：抛光留下的起伏。没有这一层，反射会像 CAD 渲染一样干净得假
  N.xy += (vec2(vnoise(p * 2.6), vnoise(p * 2.6 + 11.3)) - 0.5) * 0.055;
  N = normalize(N);

  // 视线方向随倾斜变化：指针在哪一侧，反射就扫向哪一侧
  vec3 V = normalize(vec3(uTilt.x * 0.55, uTilt.y * 0.55, 1.0));
  float ndv = clamp(dot(N, V), 0.0, 1.0);
  vec3 R = reflect(-V, N);

  // Fresnel：正对时是金属本色，掠射趋近全反射
  vec3 F = uTint + (1.0 - uTint) * pow(1.0 - ndv, 5.0);
  vec3 col = environment(R) * F;

  // 顶光高光（Blinn-Phong 高次幂近似 GGX），被金属本色染色
  vec3 L = normalize(vec3(-0.28, -0.52, 0.81));
  vec3 H = normalize(L + V);
  col += uTint * pow(clamp(dot(N, H), 0.0, 1.0), 700.0) * 2.0;

  // 跟着指针走的一团柔光（很轻：它只负责"手在动"的反馈，不该盖掉环境）
  vec2 glareAt = 0.5 + uTilt * 0.26;
  float glareDist = length((uv - glareAt) * vec2(aspect, 1.0));
  col += vec3(1.0, 0.98, 0.95) * exp(-glareDist * glareDist * 16.0) * 0.10;

  // 倒角：紧贴边内侧压一道，再在倒角面上按光来的方向补一记亮线。
  // 有方向的倒角才像压出来的钢板；四边等亮的圆环只会像描边。
  // 法线里不做这件事：径向扰动会把环境里的灯带拧成弧形，看着像脏污。
  float edgeDist = max(abs(radial.x), abs(radial.y));
  float rimMask = smoothstep(0.90, 1.0, edgeDist);
  vec2 outward = normalize(p + vec2(1e-4));
  float rimLight = clamp(dot(outward, normalize(vec2(-0.55, 0.84))), 0.0, 1.0);
  col *= mix(0.86, 1.0, smoothstep(0.0, 0.20, edgeDist));
  col += (uTint * 0.6 + vec3(0.4)) * rimMask * (0.08 + 0.62 * rimLight);

  // 顶亮底暗：板子是被上方灯照着的
  col *= mix(0.92, 1.04, uv.y);

  // 颗粒：绝对光滑的镜面看着像塑料
  col += (hash21(gl_FragCoord.xy) - 0.5) * 0.012;

  // 色调映射 + gamma：避免灯带处整片死白
  col = vec3(1.0) - exp(-col * 0.95);
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
}

let state: GlState | null = null;
/** WebGL2 这条路彻底不可用（创建失败 / 上下文丢失）：本页后续一律走 2D 回退 */
let unusable = false;

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
  };
}

/**
 * 2D 回退：没有 WebGL2 时给一块"像金属"的底，别留白。
 * 只用渐变，不做逐像素光照——这一类设备本来也吃不动。
 */
function paintFallback(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  { tiltX, tiltY }: MirrorOptions,
  { tint, accent }: MirrorPalette,
): void {
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
  ctx.fillStyle = 'rgba(6, 10, 16, 0.08)';
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
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // 同一帧内贴回去：preserveDrawingBuffer 保证这里读得到刚画的内容
    ctx.drawImage(glState.canvas, 0, 0, w, h);
  } else {
    paintFallback(ctx, w, h, options, palette);
  }

  paintScrims(ctx, w, h);
}
