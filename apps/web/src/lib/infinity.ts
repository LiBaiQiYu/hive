/**
 * 无限镜（Infinity Mirror）卡面。
 *
 * 现实里的无限镜 = 两块镜子对着放，中间一圈 LED：人看到的是 LED 环被反复反射，
 * 形成一条"越来越小、越来越暗"的光廊。这里把这个结构直接画出来：
 *
 *   1. 环按**几何级数**缩小（0.885^n），不是等距缩小——反射在深度上等距，
 *      投影到平面上就是几何收敛；等距缩小的环看着像同心方框，不像走廊；
 *   2. 环的**视差按深度加权**：近处的环跟着指针走得远，远处的几乎不动，
 *      再叠加消失点的整体位移，于是指针一动，整条廊道的透视是"转过去看"而不是"整张图平移"；
 *   3. 亮度随深度衰减、线宽随尺寸衰减，远端补一团辉光当光源，
 *      近端用两道描边（宽而淡 + 窄而亮）做廉价但有效的发光；
 *   4. 地板：把廊道沿地平线**镜像**一份、压暗叠在下方——真镜子才有下半截，
 *      这一步比画任何高光都更像"一块立在反光地板上的镜子"；
 *   5. 玻璃感：斜向高光、顶部边缘反光、四角压暗，外加下半部一层暗色蒙版
 *      （文字压在最亮的位置上，不压暗读不清）。
 *
 * 指针静止时 --px/--py 为 0，廊道回到正中——和卡片倾斜用的是同一套输入。
 */

export interface InfinityOptions {
  tiltX: number;
  tiltY: number;
}

/** 环的数量：足够多才有"无限"感，再多彩蛋就变成噪点了 */
const RINGS = 36;
/** 每一环相对上一环的缩放：0.885 是试出来的，再大显不出纵深，再小中间会空 */
const SHRINK = 0.885;
/** 地平线（地板镜像的对称轴），0~1 相对卡高。压得低一点，只让底部透出一小截 */
const HORIZON = 0.78;

function roundedRect(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  hw: number,
  hh: number,
  radius: number,
): void {
  const r = Math.max(0, Math.min(radius, hw, hh));
  ctx.beginPath();
  ctx.moveTo(cx - hw + r, cy - hh);
  ctx.lineTo(cx + hw - r, cy - hh);
  ctx.quadraticCurveTo(cx + hw, cy - hh, cx + hw, cy - hh + r);
  ctx.lineTo(cx + hw, cy + hh - r);
  ctx.quadraticCurveTo(cx + hw, cy + hh, cx + hw - r, cy + hh);
  ctx.lineTo(cx - hw + r, cy + hh);
  ctx.quadraticCurveTo(cx - hw, cy + hh, cx - hw, cy + hh - r);
  ctx.lineTo(cx - hw, cy - hh + r);
  ctx.quadraticCurveTo(cx - hw, cy - hh, cx - hw + r, cy - hh);
  ctx.closePath();
}

/** 画一圈环：宽淡光晕 + 窄亮芯线 + 四角灯珠 */
function strokeRing(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  hw: number,
  hh: number,
  scale: number,
  alpha: number,
  hue: number,
): void {
  const radius = Math.min(hw, hh) * 0.26;
  const core = Math.max(0.6, 3.1 * scale);

  // 光晕：宽一点、淡一点。刻意不用 shadowBlur —— 每帧几十个 shadowBlur 会明显掉帧
  roundedRect(ctx, cx, cy, hw, hh, radius);
  ctx.lineWidth = core * 5;
  ctx.strokeStyle = `hsla(${hue}, 100%, 70%, ${alpha * 0.18})`;
  ctx.stroke();

  // 芯线：近处更亮更白，远处偏青灰 —— 这一段是"灯带"的本体
  roundedRect(ctx, cx, cy, hw, hh, radius);
  ctx.lineWidth = core;
  ctx.strokeStyle = `hsla(${hue}, 100%, ${74 + Math.min(16, scale * 14)}%, ${alpha})`;
  ctx.stroke();

  // 四角灯珠：无限镜的灵魂是一圈 LED，缺了角上的亮点就只剩方格
  if (hw > 7) {
    const dot = Math.max(0.75, 2 * scale);
    ctx.fillStyle = `hsla(${hue + 10}, 100%, 90%, ${alpha * 0.9})`;
    for (const [sx, sy] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ] as const) {
      ctx.beginPath();
      ctx.arc(cx + sx * (hw - core), cy + sy * (hh - core), dot, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/** 整条光廊。地板镜像要复用，所以单独抽出来（镜像靠调用方设置 transform） */
function drawTunnel(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  vpx: number,
  vpy: number,
  tiltX: number,
  tiltY: number,
): void {
  const hw0 = w * 0.47;
  const hh0 = h * 0.41;

  for (let i = 0; i < RINGS; i += 1) {
    const t = i / (RINGS - 1);
    const scale = Math.pow(SHRINK, i);
    const hw = hw0 * scale;
    const hh = hh0 * scale;
    if (hw < 1.4 || hh < 1.4) break;

    // 近环（depth≈1）位移大，远环（depth≈0）几乎不动 —— 透视感就来自这个权重
    const depth = 1 - t;
    const shift = Math.pow(depth, 1.5);
    const cx = vpx + tiltX * shift * 13;
    const cy = vpy + tiltY * shift * 10;

    // 亮度：近处亮、远处暗；远端留一点底光，免得尽头是一团纯黑
    const alpha = 0.05 + 0.62 * Math.pow(depth, 0.9);
    // 色相从冷青往冰紫偏一点点，模拟厚玻璃边缘的色散
    const hue = 192 + t * 22 + tiltX * 6;

    strokeRing(ctx, cx, cy, hw, hh, scale, alpha, hue);
  }
}

export function renderInfinityFrame(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  { tiltX, tiltY }: InfinityOptions,
): number {
  const w = Math.max(2, Math.round(width));
  const h = Math.max(2, Math.round(height));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) return 0;

  ctx.clearRect(0, 0, w, h);

  // 1) 镜面底色：冷蓝到近黑，斜一点，避免死板的水平渐变
  const base = ctx.createLinearGradient(0, 0, w * 0.28, h);
  base.addColorStop(0, '#05070f');
  base.addColorStop(0.55, '#071528');
  base.addColorStop(1, '#03040a');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, w, h);

  // 2) 消失点：指针往右，视点往右看，廊道整体被"推"到左边一点
  const vpx = w * (0.5 + tiltX * 0.032);
  const vpy = h * (0.38 + tiltY * 0.028);

  // 3) 远端光源先铺一层辉光，环压在上面，中心才像"有光射过来"
  const farGlow = ctx.createRadialGradient(vpx, vpy, 0, vpx, vpy, Math.max(w, h) * 0.36);
  farGlow.addColorStop(0, 'rgba(232, 249, 255, 0.9)');
  farGlow.addColorStop(0.1, 'rgba(150, 220, 255, 0.55)');
  farGlow.addColorStop(0.34, 'rgba(58, 130, 230, 0.18)');
  farGlow.addColorStop(1, 'rgba(10, 24, 50, 0)');
  ctx.fillStyle = farGlow;
  ctx.fillRect(0, 0, w, h);

  // 4) 光廊
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  drawTunnel(ctx, w, h, vpx, vpy, tiltX, tiltY);
  ctx.restore();

  // 5) 文字压暗：先压一层冷黑蒙版，再叠地板镜像。
  //    顺序很关键——镜像用 lighter 发光，放后面才能在暗底上"透"出来；
  //    反过来（先镜像后蒙版）会把下半截全糊掉，等于白画。
  const scrim = ctx.createLinearGradient(0, h * 0.42, 0, h);
  scrim.addColorStop(0, 'rgba(3, 7, 16, 0)');
  scrim.addColorStop(0.4, 'rgba(3, 7, 16, 0.3)');
  scrim.addColorStop(1, 'rgba(2, 5, 12, 0.52)');
  ctx.fillStyle = scrim;
  ctx.fillRect(0, h * 0.42, w, h * 0.58);

  // 6) 地板：把光廊沿地平线镜像一份压暗（真镜子才有下半截），只留地平线以下
  const horizonY = h * HORIZON;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, horizonY, w, h - horizonY);
  ctx.clip();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 0.16;
  ctx.translate(0, horizonY * 2);
  ctx.scale(1, -1);
  drawTunnel(ctx, w, h, vpx, vpy, tiltX, tiltY);
  ctx.restore();

  // 7) 地板的抛光感：越靠下越亮的冷光 + 两条向消失点收敛的地平线
  const floor = ctx.createLinearGradient(0, horizonY, 0, h);
  floor.addColorStop(0, 'rgba(40, 110, 200, 0)');
  floor.addColorStop(0.6, 'rgba(60, 140, 230, 0.08)');
  floor.addColorStop(1, 'rgba(120, 200, 255, 0.13)');
  ctx.fillStyle = floor;
  ctx.fillRect(0, horizonY, w, h - horizonY);

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(150, 225, 255, 0.14)';
  for (const edge of [0, w]) {
    ctx.beginPath();
    ctx.moveTo(edge, h);
    ctx.lineTo(vpx, horizonY);
    ctx.stroke();
  }
  // 尽头那道光：一条窄亮的竖缝 + 一小团辉光。
  // 辉光刻意收小（半径 0.07、透明度 0.45）：画大了就变成卡片中间的一盏灯，
  // 压在「天梯 MMR」这类正文上很脏。
  const coreH = Math.max(5, h * 0.075);
  const coreW = Math.max(1.4, w * 0.008);
  const coreGlow = ctx.createRadialGradient(vpx, vpy, 0, vpx, vpy, Math.max(w, h) * 0.07);
  coreGlow.addColorStop(0, 'rgba(245, 253, 255, 0.45)');
  coreGlow.addColorStop(0.4, 'rgba(170, 230, 255, 0.16)');
  coreGlow.addColorStop(1, 'rgba(120, 200, 255, 0)');
  ctx.fillStyle = coreGlow;
  ctx.fillRect(vpx - w * 0.07, vpy - h * 0.07, w * 0.14, h * 0.14);
  roundedRect(ctx, vpx, vpy, coreW, coreH, coreW);
  ctx.fillStyle = 'rgba(250, 254, 255, 0.92)';
  ctx.fill();
  ctx.restore();

  // 边缘镜框：贴着卡片内沿再描一圈亮线，上亮下暗、偏紫一点，
  // 让"光廊"和"玻璃板"长出同一副骨架，而不是两张皮
  const rimInset = 1.5;
  const rimGlow = ctx.createLinearGradient(0, 0, w, h);
  rimGlow.addColorStop(0, 'rgba(235, 252, 255, 0.55)');
  rimGlow.addColorStop(0.45, 'rgba(150, 226, 255, 0.28)');
  rimGlow.addColorStop(1, 'rgba(170, 160, 255, 0.34)');
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  roundedRect(ctx, w / 2, h / 2, w / 2 - rimInset, h / 2 - rimInset, 13);
  ctx.lineWidth = 3.5;
  ctx.strokeStyle = 'rgba(120, 200, 255, 0.16)';
  ctx.stroke();
  roundedRect(ctx, w / 2, h / 2, w / 2 - rimInset, h / 2 - rimInset, 13);
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = rimGlow;
  ctx.stroke();
  ctx.restore();

  // 8) 玻璃高光：斜向亮带 + 一道镜面反光条 + 顶部边缘反光
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  const gloss = ctx.createLinearGradient(w * 0.1, 0, w * 0.9, h);
  gloss.addColorStop(0, 'rgba(200, 235, 255, 0.16)');
  gloss.addColorStop(0.34, 'rgba(255, 255, 255, 0.03)');
  gloss.addColorStop(0.62, 'rgba(150, 205, 255, 0.13)');
  gloss.addColorStop(1, 'rgba(255, 255, 255, 0.02)');
  ctx.fillStyle = gloss;
  ctx.fillRect(0, 0, w, h);

  // 镜面反光条：一条 18° 的窄亮带，压在左上角，玻璃板才有"厚度"
  ctx.save();
  ctx.translate(w * 0.34, h * 0.2);
  ctx.rotate(-0.32);
  const streak = ctx.createLinearGradient(0, -h * 0.06, 0, h * 0.06);
  streak.addColorStop(0, 'rgba(255, 255, 255, 0)');
  streak.addColorStop(0.5, 'rgba(228, 248, 255, 0.13)');
  streak.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = streak;
  ctx.fillRect(-w, -h * 0.06, w * 2, h * 0.12);
  ctx.restore();

  const topEdge = ctx.createLinearGradient(0, 0, 0, h * 0.14);
  topEdge.addColorStop(0, 'rgba(230, 250, 255, 0.22)');
  topEdge.addColorStop(1, 'rgba(230, 250, 255, 0)');
  ctx.fillStyle = topEdge;
  ctx.fillRect(0, 0, w, h * 0.14);
  ctx.restore();

  // 9) 暗角：把四角压下去，中心的亮才显得是"从深处射出来的"
  const vignette = ctx.createRadialGradient(
    vpx,
    vpy,
    Math.min(w, h) * 0.16,
    vpx,
    vpy,
    Math.max(w, h) * 0.8,
  );
  vignette.addColorStop(0, 'rgba(0, 0, 0, 0)');
  vignette.addColorStop(0.68, 'rgba(0, 0, 0, 0.3)');
  vignette.addColorStop(1, 'rgba(0, 0, 0, 0.66)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, w, h);

  return 0;
}
