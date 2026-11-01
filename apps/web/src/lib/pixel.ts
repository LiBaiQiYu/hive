/**
 * 像素卡面的程序化渲染。
 *
 * 和全息一样是"倾斜驱动的色相变化"，只是把画面拆成一颗颗像素点：
 *  1. 网格：每个像素格有自己的色相/明度扰动（同一个色系里随机偏一点，
 *     所以不是一整片纯色，而是像老游戏调色板那样有细微差异）；
 *  2. 色相基准随倾斜角变化：左右划动时整张卡的色相缓慢漂移，
 *     和全息卡的"转个角度换色"是同一套机制；
 *  3. 加一条对角方向的色相坡度 + 少量高亮像素，避免规则网格的呆板。
 *
 * 像素格用整数坐标绘制、格子之间留 1px 缝，保持硬边像素感。
 */

export interface PixelOptions {
  tiltX: number;
  tiltY: number;
}

const CELL = 6;

interface PixelGrid {
  width: number;
  height: number;
  cols: number;
  rows: number;
  hue: Float32Array;
  light: Float32Array;
  sat: Float32Array;
  spark: Uint8Array;
}

const cache = new Map<string, PixelGrid>();

function hash2(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function buildGrid(width: number, height: number): PixelGrid {
  const cols = Math.max(1, Math.ceil(width / CELL));
  const rows = Math.max(1, Math.ceil(height / CELL));
  const count = cols * rows;
  const hue = new Float32Array(count);
  const light = new Float32Array(count);
  const sat = new Float32Array(count);
  const spark = new Uint8Array(count);

  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      const i = y * cols + x;
      const a = hash2(x + 0.5, y + 0.5);
      const b = hash2(x * 1.7 + 3.1, y * 2.3 + 7.7);
      const c = hash2(x * 0.7 + 11.3, y * 1.9 + 5.1);

      // 同一个色系里的随机偏移：色相 ±22°，明度 ±7%，饱和 ±10%
      hue[i] = (a - 0.5) * 44;
      light[i] = (b - 0.5) * 14;
      sat[i] = (c - 0.5) * 20;
      spark[i] = a > 0.935 ? 1 : 0;
    }
  }

  return { width, height, cols, rows, hue, light, sat, spark };
}

function getGrid(width: number, height: number): PixelGrid {
  const key = `${width}x${height}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const grid = buildGrid(width, height);
  cache.set(key, grid);
  return grid;
}

/**
 * 把一帧像素卡面画进 canvas。返回当前的色相基准，方便外部调试。
 */
export function renderPixelFrame(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  { tiltX, tiltY }: PixelOptions,
): number {
  const w = Math.max(CELL, Math.round(width));
  const h = Math.max(CELL, Math.round(height));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) return 0;

  const grid = getGrid(w, h);
  // 色相基准：左右滑 ±42°，上下再带一点；和全息卡一个思路，只是幅度更收敛
  const hueBase = 214 + tiltX * 42 + tiltY * 16;

  ctx.clearRect(0, 0, w, h);

  for (let y = 0; y < grid.rows; y += 1) {
    for (let x = 0; x < grid.cols; x += 1) {
      const i = y * grid.cols + x;
      // 对角坡度：左上和右下不是同一个色调，避免整片均匀
      const slope = (x / grid.cols) * 16 + (y / grid.rows) * 9;
      const hue = hueBase + (grid.hue[i] as number) + slope;
      const sat = 52 + (grid.sat[i] as number);
      const light =
        22 + (grid.light[i] as number) + tiltY * 3 + (grid.spark[i] ? 16 : 0);

      ctx.fillStyle = `hsl(${hue.toFixed(0)} ${Math.min(86, Math.max(28, sat)).toFixed(0)}% ${Math.min(58, Math.max(12, light)).toFixed(0)}%)`;
      // 留 1px 缝，保持硬边像素网格
      ctx.fillRect(x * CELL, y * CELL, CELL - 1, CELL - 1);
    }
  }

  // 一层很淡的扫描线，让像素更像 CRT 而不是马赛克
  ctx.fillStyle = 'rgba(0, 0, 0, 0.18)';
  for (let y = 0; y < h; y += 3) {
    ctx.fillRect(0, y, w, 1);
  }

  return hueBase;
}
