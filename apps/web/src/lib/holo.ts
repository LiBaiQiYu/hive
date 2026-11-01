/**
 * 全息箔的程序化渲染。
 *
 * 物理简化模型（够用且可解释）：
 *  1. 箔面被看成一堆微小的三角反射面（facet），每个面有自己的法线 n。
 *     面的法线来自随机扰动：n = normalize(N(0,σ), N(0,σ), 1)，σ≈0.5。
 *  2. 光来是一个固定方向 L；观察方向 V 随卡片/鼠标倾斜而变。
 *     半程向量 H = normalize(L + V)，面上的镜面强度 spec = (n·H)^p。
 *     这解释了"倾斜时亮点在不同切面之间游走"。
 *  3. 颜色来自衍射光栅：相邻切面的光程差随 (n·H) 连续变化，
 *     主波长 λ ∝ d·(sinθ_i − sinθ_m)，在 HSL 里近似成色相随
 *     (视角倾斜 + n·H) 线性漂移——这就是同一张贴纸在蓝紫与黄绿之间
 *     整体变色（手机拍全息贴纸时最常见的那种色相跳变）。
 *  4. 亮度 = 金属反射底 + 镜面项，所以暗面仍是"银底映出的颜色"，不是纯黑。
 */

export interface HoloFacet {
  /** 单位空间坐标 [0,1]，绘制时再乘画布尺寸 */
  ax: number;
  ay: number;
  bx: number;
  by: number;
  cx: number;
  cy: number;
  /** 法线 */
  nx: number;
  ny: number;
  nz: number;
  /** 每个切面的相位抖动，避免出现规则条纹 */
  jitter: number;
}

/** 固定种子的伪随机，保证每次生成同一套切面 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normalize3(x: number, y: number, z: number): [number, number, number] {
  const len = Math.hypot(x, y, z) || 1;
  return [x / len, y / len, z / len];
}

/**
 * 生成不规则三角网格：先抖动一张共享的顶点网格（相邻格子共用顶点，
 * 所以拼缝是严丝的），再逐格随机选对角线切成两个三角形。
 * 共享顶点是关键——每格各自抖动会切出一块块"瓷砖"和黑缝。
 */
export function buildHoloFacets(cols = 18, rows = 14, seed = 9137): HoloFacet[] {
  const rng = mulberry32(seed);
  const facets: HoloFacet[] = [];
  const cw = 1 / cols;
  const ch = 1 / rows;

  // 顶点网格：(cols+1) × (rows+1)，边界不抖动，保证铺满整张卡
  const vx: number[][] = [];
  const vy: number[][] = [];
  for (let r = 0; r <= rows; r += 1) {
    vx[r] = [];
    vy[r] = [];
    for (let c = 0; c <= cols; c += 1) {
      const edge = r === 0 || r === rows || c === 0 || c === cols;
      vx[r]![c] = c * cw + (edge ? 0 : (rng() - 0.5) * cw * 0.9);
      vy[r]![c] = r * ch + (edge ? 0 : (rng() - 0.5) * ch * 0.9);
    }
  }

  const push = (a: [number, number], b: [number, number], c: [number, number]) => {
    const n = normalize3((rng() - 0.5) * 1.2, (rng() - 0.5) * 1.2, 1);
    facets.push({
      ax: a[0],
      ay: a[1],
      bx: b[0],
      by: b[1],
      cx: c[0],
      cy: c[1],
      nx: n[0],
      ny: n[1],
      nz: n[2],
      jitter: rng() * 2 - 1,
    });
  };

  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const p00: [number, number] = [vx[r]![c]!, vy[r]![c]!];
      const p10: [number, number] = [vx[r]![c + 1]!, vy[r]![c + 1]!];
      const p11: [number, number] = [vx[r + 1]![c + 1]!, vy[r + 1]![c + 1]!];
      const p01: [number, number] = [vx[r + 1]![c]!, vy[r + 1]![c]!];
      if (rng() < 0.5) {
        push(p00, p10, p11);
        push(p00, p11, p01);
      } else {
        push(p00, p10, p01);
        push(p10, p11, p01);
      }
    }
  }
  return facets;
}

const FACETS = buildHoloFacets();

/** 灯光方向：左上偏前，像展厅顶灯 */
const LIGHT = normalize3(-0.42, -0.58, 0.7);

/** 同一时刻的倾斜 → 色相基准（°）。左右划动时蓝紫 ↔ 黄绿整体跳变 */
export function hueForTilt(tiltX: number): number {
  return 205 - tiltX * 105;
}

export interface HoloRenderOptions {
  /** -1..1，鼠标横向位置 */
  tiltX: number;
  /** -1..1，鼠标纵向位置 */
  tiltY: number;
  /** 整体强度 0..1 */
  intensity: number;
}

/**
 * 把一帧画进 canvas（按 CSS 像素尺寸，内部已处理 DPR）。
 * 返回色相，供边框/描边复用，保证"框和膜同时变色"。
 */
export function renderHoloFrame(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  { tiltX, tiltY, intensity }: HoloRenderOptions,
): number {
  const scale = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) return hueForTilt(tiltX);

  const view = normalize3(tiltX * 0.55, tiltY * 0.55, 1);
  const half = normalize3(LIGHT[0] + view[0], LIGHT[1] + view[1], LIGHT[2] + view[2]);
  const hueBase = hueForTilt(tiltX);

  ctx.clearRect(0, 0, w, h);
  ctx.lineJoin = 'round';

  for (const f of FACETS) {
    const ndoth = Math.max(0, f.nx * half[0] + f.ny * half[1] + f.nz * half[2]);
    const ndotv = Math.max(0, f.nx * view[0] + f.ny * view[1] + f.nz * view[2]);
    const spec = Math.pow(ndoth, 20) + Math.pow(ndoth, 5) * 0.35;
    const hue = hueBase + (ndoth - 0.5) * 78 + f.jitter * 22;
    const sat = 42 + spec * 26;
    const light = 42 + ndoth * 8 + spec * 30 + ndotv * 4;

    ctx.fillStyle = `hsl(${hue.toFixed(1)} ${Math.min(88, sat).toFixed(1)}% ${Math.min(72, light).toFixed(1)}%)`;
    ctx.beginPath();
    ctx.moveTo(f.ax * w, f.ay * h);
    ctx.lineTo(f.bx * w, f.by * h);
    ctx.lineTo(f.cx * w, f.cy * h);
    ctx.closePath();
    ctx.fill();

    // 切面边缘的细高光：模拟微晶棱线
    ctx.strokeStyle = `rgba(255, 255, 255, ${(0.04 + spec * 0.3).toFixed(3)})`;
    ctx.lineWidth = Math.max(0.5, scale * 0.55);
    ctx.stroke();
  }

  // 整体强度用一层白纱压暗/提亮（0 = 几乎看不见箔）
  if (intensity < 1) {
    ctx.fillStyle = `rgba(8, 14, 22, ${(1 - intensity) * 0.9})`;
    ctx.fillRect(0, 0, w, h);
  }

  return hueBase;
}
