/**
 * 金属卡面的实时渲染（黄金）。
 *
 * 用的是离线渲染里那套微表面模型（Cook-Torrance 的简化版），
 * 每一项都能对应到物理量：
 *
 *  1. 金属没有漫反射：颜色来自"反射的环境"乘 Fresnel 反射率，
 *     所以金卡在暗处是暖褐色、亮处才发白 —— 不是把黄色渐变画上去。
 *  2. Fresnel（Schlick 近似）：F = F0 + (1 - F0)(1 - cosθ)^5。
 *     正对视角时反射的是金属本色（F0，金的 F0 ≈ (1.0, 0.72, 0.32)），
 *     越接近掠射角越接近全反射，边缘会发白 —— 卡边会随角度提亮。
 *  3. 微表面法线：拉丝金属的沟槽沿一个方向排列，法线的横向扰动
 *     比纵向大一个数量级，于是高光被拉成横条（Kajiya-Kay 各向异性高光）。
 *  4. 叠几道低频正弦起伏（wave），模拟压延/锤打留下的大尺度曲面，
 *     反射会被"揉"成流动的金带——这是参考图里那种波光的来源。
 *  5. 光照：一个固定的主光 + 环境（顶部暖白、地平线金、底部暗），
 *     视线方向 V 随卡片倾斜改变，反射向量 R = 2(N·V)N - V 跟着扫过环境，
 *     高光就沿卡面滑动。
 *
 * 性能：法线贴图按尺寸预计算一次（与光照无关），每帧只做逐像素光照，
 * 因此只有金色卡片、且只在倾斜变化时才重绘。
 */

export interface MetalOptions {
  /** -1..1，鼠标横向位置换算的视角倾角 */
  tiltX: number;
  /** -1..1，鼠标纵向位置 */
  tiltY: number;
}

/** 金的 F0（线性空间近似，sRGB 下呈现暖金） */
const GOLD_F0 = [1.0, 0.7, 0.26] as const;

const KEY_LIGHT = normalize3(-0.45, -0.6, 0.66);
/** 环境里的主光箱方向（画面左上方的那块亮面） */
const KEY_BOX = normalize3(-0.38, 0.52, 0.76);
/** 环境里的补光（右侧轮廓光） */
const RIM_BOX = normalize3(0.78, 0.12, 0.61);
/** 第二块细长灯条：它在金属面上映成一道锐利的高光条，随倾斜滑动 */
const STRIP_BOX = normalize3(0.15, 0.62, 0.77);

function normalize3(x: number, y: number, z: number): [number, number, number] {
  const len = Math.hypot(x, y, z) || 1;
  return [x / len, y / len, z / len];
}

/** 便宜且确定的 hash，用于拉丝颗粒 */
function hash2(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

interface NormalMap {
  width: number;
  height: number;
  nx: Float32Array;
  ny: Float32Array;
  nz: Float32Array;
}

const normalCache = new Map<string, NormalMap>();

/**
 * 预计算法线贴图：拉丝沟槽（高频横纹）+ 大尺度起伏（低频波），
 * 与视角无关，所以只算一次。
 */
function buildNormals(width: number, height: number): NormalMap {
  const count = width * height;
  const nx = new Float32Array(count);
  const ny = new Float32Array(count);
  const nz = new Float32Array(count);

  for (let y = 0; y < height; y += 1) {
    const gy = y / height;
    for (let x = 0; x < width; x += 1) {
      const gx = x / width;
      const i = y * width + x;

      // 拉丝：沟槽沿 x 方向延伸，法线主要沿 y 方向起伏（低频正弦，别用逐像素噪声，
      // 否则 1:1 渲染会变成噪点/砂纸）
      const brush = Math.sin(y * 0.34 + gx * 1.6) * 0.5 + Math.sin(y * 0.83 + 0.9) * 0.22;
      // 大尺度压延起伏：让环境反射被揉成流动的金带
      const wave =
        Math.sin(gx * 3.1 + gy * 1.4 + 0.7) * 0.5 + Math.sin(gx * 1.6 - gy * 2.6 + 1.9) * 0.5;

      const nxn = Math.cos(gy * 2.6 + gx * 1.8) * 0.035;
      const nyn = brush * 0.018 + wave * 0.12;

      const inv = 1 / Math.hypot(nxn, nyn, 1);
      nx[i] = nxn * inv;
      ny[i] = nyn * inv;
      nz[i] = inv;
    }
  }

  return { width, height, nx, ny, nz };
}

function getNormals(width: number, height: number): NormalMap {
  const key = `${width}x${height}`;
  const cached = normalCache.get(key);
  if (cached) return cached;
  const built = buildNormals(width, height);
  normalCache.set(key, built);
  return built;
}

/**
 * 把一帧金属光照画进 canvas。返回主光的视觉强度，方便外部做微调。
 */
export function renderMetalFrame(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  { tiltX, tiltY }: MetalOptions,
): number {
  // 金属面是低频渐变，1x 渲染再让 CSS 拉伸足够（省掉 4 倍的逐像素开销）
  const w = Math.max(2, Math.round(width));
  const h = Math.max(2, Math.round(height));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) return 0;

  const normals = getNormals(w, h);
  const image = ctx.createImageData(w, h);
  const data = image.data;

  const view = normalize3(tiltX * 0.5, tiltY * 0.5, 1);
  const half = normalize3(
    KEY_LIGHT[0] + view[0],
    KEY_LIGHT[1] + view[1],
    KEY_LIGHT[2] + view[2],
  );

  let brightest = 0;

  for (let i = 0, p = 0; i < w * h; i += 1, p += 4) {
    const n0 = normals.nx[i] as number;
    const n1 = normals.ny[i] as number;
    const n2 = normals.nz[i] as number;

    const ndv = n0 * view[0] + n1 * view[1] + n2 * view[2];
    const ndvClamped = ndv > 0 ? ndv : 0;

    // 反射向量 R = 2(N·V)N - V
    const rx = 2 * ndvClamped * n0 - view[0];
    const ry = 2 * ndvClamped * n1 - view[1];
    const rz = 2 * ndvClamped * n2 - view[2];

    // 环境：天顶暖白 → 地平线金 → 地面暗褐
    const t = smoothstep(0.0, 1.0, ry * 0.5 + 0.5);
    let er = 0.012 + (0.36 - 0.012) * t;
    let eg = 0.008 + (0.22 - 0.008) * t;
    let eb = 0.003 + (0.1 - 0.003) * t;

    // 地平线附近一条亮带（像展厅里的灯带）
    const horizon = Math.exp(-ry * ry * 16) * 0.34;
    er += horizon;
    eg += horizon * 0.86;
    eb += horizon * 0.55;

    // 主光箱 + 右侧补光（环境里的两块亮面，反射到哪就亮到哪）
    const kd = rx * KEY_BOX[0] + ry * KEY_BOX[1] + rz * KEY_BOX[2];
    const box = smoothstep(0.85, 0.997, kd) * 2.9 * kd;
    const rd = rx * RIM_BOX[0] + ry * RIM_BOX[1] + rz * RIM_BOX[2];
    const rim = smoothstep(0.72, 0.99, rd) * 0.55;
    const sd = rx * STRIP_BOX[0] + ry * STRIP_BOX[1] + rz * STRIP_BOX[2];
    const strip = smoothstep(0.94, 0.999, sd) * 2.6;

    er += box + strip + rim * 0.9;
    eg += box * 0.9 + strip * 0.92 + rim * 0.82;
    eb += box * 0.72 + strip * 0.78 + rim * 0.62;

    // Fresnel（Schlick）：正对=金属本色，掠射→全反射
    const c = 1 - ndvClamped;
    const c5 = c * c * c * c * c;
    const fr = GOLD_F0[0] + (1 - GOLD_F0[0]) * c5;
    const fg = GOLD_F0[1] + (1 - GOLD_F0[1]) * c5;
    const fb = GOLD_F0[2] + (1 - GOLD_F0[2]) * c5;

    // 主光的镜面项：GGX 太贵，用 Blinn-Phong 高次幂近似，足够锐
    const ndh = Math.max(0, n0 * half[0] + n1 * half[1] + n2 * half[2]);
    const ndh2 = ndh * ndh;
    const ndh4 = ndh2 * ndh2;
    const ndh8 = ndh4 * ndh4;
    const spec = ndh8 * ndh8 * 2.4;

    // 金属的高光是被 F0 染色的，不是白光 —— 直接用白色会变成珍珠纸
    let cr = (er + spec) * fr;
    let cg = (eg + spec) * fg;
    let cb = (eb + spec) * fb;

    if (cr > brightest) brightest = cr;

    // 便宜的色调映射 + gamma，避免高光直接死白
    cr = 1 - Math.exp(-cr * 0.85);
    cg = 1 - Math.exp(-cg * 0.85);
    cb = 1 - Math.exp(-cb * 0.85);

    data[p] = (Math.pow(cr, 1 / 2.2) * 255) | 0;
    data[p + 1] = (Math.pow(cg, 1 / 2.2) * 255) | 0;
    data[p + 2] = (Math.pow(cb, 1 / 2.2) * 255) | 0;
    data[p + 3] = 255;
  }

  ctx.putImageData(image, 0, 0);
  return brightest;
}
