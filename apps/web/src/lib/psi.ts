/**
 * 灵能 / 色彩破碎（数字故障）卡面。
 *
 * 参考的是影视里"进入数字世界"的故障画面：不是光源，而是**信号断层**——
 * 颜色被拆成红绿蓝三个通道、错位叠加；画面被横向切片后整块移位；
 * 明暗被压成有限几阶，形成可见的色阶断层。
 *
 * 具体做了五件事：
 *  1. 底色：深靛蓝，但用有限几阶的横向色带拼出来（不是平滑渐变）——
 *     这就是"色阶断层"的来源；
 *  2. 碎晶：每片都按 R/G/B 三个通道分别错位 1~2px 叠加（lighter 混合），
 *     边缘于是出现红/绿/蓝的割裂边；
 *  3. 横向撕裂：把画布自己的一段横条整块复制到偏移位置（datamosh 的做法），
 *     偏移量随倾斜改变，倾斜时整条带子在滑动；
 *  4. 扫描线 + 噪点块：细横线和随机小色块，模拟信号损坏；
 *  5. 色相基准 hueBase 随倾斜漂移，碎晶按深度做视差。
 */

export interface PsiOptions {
  tiltX: number;
  tiltY: number;
}

/** 棱镜色板：叠加到 hueBase 上的偏移量 */
const PALETTE = [0, 62, 128, 196, -55, -120];

/** R/G/B 三通道的错位量，正负各来一份，叠加后就是彩边 */
const CHANNELS = [
  { dx: -1.8, color: 'rgba(255, 60, 90, 0.5)' },
  { dx: 0, color: 'rgba(70, 255, 150, 0.42)' },
  { dx: 1.8, color: 'rgba(90, 130, 255, 0.5)' },
] as const;

interface Shard {
  points: number[];
  depth: number;
  hueA: number;
  hueB: number;
  alpha: number;
}

interface PsiGeometry {
  width: number;
  height: number;
  shards: Shard[];
  tears: { y: number; h: number; offset: number; hue: number }[];
  noise: { x: number; y: number; w: number; h: number; hue: number }[];
}

const cache = new Map<string, PsiGeometry>();

function hash2(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function buildGeometry(width: number, height: number): PsiGeometry {
  const rng = (i: number) => hash2(i * 1.37 + 5.1, i * 0.71 + 2.3);
  const shards: Shard[] = [];

  for (let i = 0; i < 52; i += 1) {
    const cx = rng(i * 6.7);
    const cy = rng(i * 8.3);
    const size = (0.02 + rng(i * 9.1) * 0.07) * Math.min(width, height);
    const sides = 3 + Math.floor(rng(i * 10.3) * 2.4);
    const rot = rng(i * 11.7) * Math.PI * 2;
    const points: number[] = [];
    for (let s = 0; s < sides; s += 1) {
      const a = rot + (s / sides) * Math.PI * 2 + (rng(i * 12.9 + s) - 0.5) * 0.7;
      const r = size * (0.5 + rng(i * 13.7 + s) * 0.85);
      points.push(cx * width + Math.cos(a) * r, cy * height + Math.sin(a) * r);
    }
    shards.push({
      points,
      depth: rng(i * 14.3),
      hueA: (PALETTE[Math.floor(rng(i * 15.1) * PALETTE.length)] as number) + (rng(i * 16.1) - 0.5) * 30,
      hueB: (PALETTE[Math.floor(rng(i * 16.7) * PALETTE.length)] as number) + (rng(i * 17.1) - 0.5) * 30,
      alpha: 0.12 + rng(i * 17.3) * 0.24,
    });
  }

  const tears = Array.from({ length: 13 }, (_, i) => ({
    y: rng(i * 21.3) * height,
    h: (0.01 + rng(i * 22.7) * 0.05) * height,
    offset: (rng(i * 23.9) - 0.5) * width * 0.16,
    hue: (rng(i * 24.1) - 0.5) * 140,
  }));

  const noise = Array.from({ length: 46 }, (_, i) => ({
    x: rng(i * 31.7) * width,
    y: rng(i * 32.9) * height,
    w: (0.004 + rng(i * 33.1) * 0.03) * width,
    h: Math.max(1, (0.002 + rng(i * 34.3) * 0.012) * height),
    hue: (rng(i * 35.9) - 0.5) * 160,
  }));

  return { width, height, shards, tears, noise };
}

function getGeometry(width: number, height: number): PsiGeometry {
  const key = `${width}x${height}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const built = buildGeometry(width, height);
  cache.set(key, built);
  return built;
}

function pathFrom(ctx: CanvasRenderingContext2D, points: number[]): void {
  ctx.beginPath();
  ctx.moveTo(points[0] as number, points[1] as number);
  for (let i = 2; i < points.length; i += 2) {
    ctx.lineTo(points[i] as number, points[i + 1] as number);
  }
  ctx.closePath();
}

export function renderPsiFrame(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  { tiltX, tiltY }: PsiOptions,
): number {
  const w = Math.max(2, Math.round(width));
  const h = Math.max(2, Math.round(height));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) return 0;

  const geo = getGeometry(w, h);
  const hueBase = 262 + tiltX * 52 + tiltY * 16;

  ctx.clearRect(0, 0, w, h);

  // 1. 底色：用有限几阶的横带拼出来，而不是平滑渐变 —— 这就是色阶断层
  const bands = 9;
  for (let i = 0; i < bands; i += 1) {
    const t = i / (bands - 1);
    const light = 10 - t * 5;
    ctx.fillStyle = `hsl(${hueBase + 8 - t * 26}, ${46 + t * 12}%, ${light}%)`;
    ctx.fillRect(0, (i * h) / bands, w, h / bands + 1);
  }

  // 中心辉光（只加一点点，故障感靠断层不靠光）
  const glow = ctx.createRadialGradient(w * 0.55, h * 0.5, 0, w * 0.55, h * 0.5, w * 0.6);
  glow.addColorStop(0, `hsla(${hueBase + 26}, 92%, 58%, 0.22)`);
  glow.addColorStop(0.5, `hsla(${hueBase - 60}, 92%, 52%, 0.1)`);
  glow.addColorStop(1, 'transparent');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);

  // 2. 碎晶：R/G/B 三通道错位叠加，形成红绿蓝割裂的彩边
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const shard of geo.shards) {
    const ox = tiltX * (shard.depth - 0.5) * 14;
    const oy = tiltY * (shard.depth - 0.5) * 10;
    for (const channel of CHANNELS) {
      const pts = shard.points.map(
        (v, i) => v + (i % 2 === 0 ? ox + channel.dx : oy),
      );
      pathFrom(ctx, pts);
      ctx.fillStyle = channel.color;
      ctx.globalAlpha = shard.alpha;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  ctx.restore();

  // 3. 横向撕裂：把画布自己的一段横条整块复制到偏移位置（datamosh）
  for (const tear of geo.tears) {
    const y = Math.round(tear.y + tiltY * 6) % h;
    const bh = Math.max(2, Math.round(tear.h));
    const dx = Math.round(tear.offset + tiltX * 10);
    ctx.drawImage(canvas, 0, y, w, bh, dx, y, w, bh);

    // 撕裂边缘补一条高饱和色，像信号溢出
    ctx.fillStyle = `hsla(${hueBase + tear.hue}, 100%, 62%, 0.35)`;
    ctx.fillRect(dx, y, w, 1);
  }

  // 4. 噪点块：随机小色块 = 传输损坏
  for (const n of geo.noise) {
    ctx.fillStyle = `hsla(${hueBase + n.hue}, 100%, ${45 + (n.hue % 20)}%, 0.28)`;
    ctx.fillRect(n.x, n.y, n.w, n.h);
  }

  // 5. 扫描线：细横线，压出 CRT 的味道
  ctx.fillStyle = 'rgba(0, 0, 0, 0.16)';
  for (let y = 0; y < h; y += 3) {
    ctx.fillRect(0, y, w, 1);
  }

  return hueBase;
}
