/**
 * 无限镜（Infinity Mirror）卡面。
 *
 * 现实里的无限镜 = 两块镜子对着放，中间一圈 LED。人眼看到的，是这一圈 LED
 * 被反复反射：每一次反射都更远、更小、更暗。所以这里不做"同心方框"的 2D 近似，
 * 而是**真的搭一个三维管**再投影下来：
 *
 *   1. 截面是一个圆角矩形（和卡片同比例、同圆角），沿 +Z 一层层复制 τ = 0 到 Z；
 *      每层在空间里是**同一尺寸**，看起来变小只是透视（1/z），所以宽高比永远和卡片一致；
 *   2. 层与层之间铺侧壁（内壁）。侧壁是不透光的，于是**近层会挡住远层**——
 *      斜着看时只剩最前面两三层，这正是光学上会发生的事；
 *   3. 亮度按反射次数指数衰减（0.9^i，镜面每次反射都损失光），
 *      所以越深越暗，而不是靠"远处画小一点"糊弄；
 *   4. 相机和卡片共用同一个视角：卡片往哪边转，整条廊道就绕卡片平面中心转同样的角度，
 *      每层都用同一个投影矩阵——外层卡片和内层反射是同一个三维空间，
 *      不会出现"外层转了、内层只是平移"的割裂感。
 *
 * 角度映射刻意放大（指针到角上约 45°/35°）：卡片的 CSS 倾斜最多 ±13°，
 * 真按 13° 画，透视遮挡根本出不来，看着还是一叠同心框。
 */

export interface InfinityOptions {
  tiltX: number;
  tiltY: number;
}

/**
 * 内视角与卡片保持一致：卡片自己的 CSS 倾斜是 rotateX(±11°) rotateY(±13°)，
 * 这里取同样的幅度，内部光廊就是**同一个视角下的三维空间**，不多不少。
 * （早先放大到 54°/36° 是为了让遮挡显眼，代价是和卡片的转动对不上，已收回来。）
 */
const MAX_YAW = (13 * Math.PI) / 180;
const MAX_PITCH = (11 * Math.PI) / 180;

/** 层数上限：亮度衰减到看不见就提前收工 */
const MAX_LAYERS = 40;
/** 每次反射保留的光量：0.9 是两面普通镜子的量级 */
const REFLECTANCE = 0.9;
/** 层间距（相对卡片长边的比例）：间距/相机距离 ≈ 0.18 时，第一层缩到 0.85 左右 */
const DEPTH_STEP = 0.18;
/** 圆角矩形截面每个角取几个采样点（含端点） */
const CORNER_STEPS = 3;

interface Point2 {
  x: number;
  y: number;
}

interface Point3 {
  x: number;
  y: number;
  z: number;
}

/**
 * 圆角矩形截面：和卡片同比例、同圆角。返回一圈点（顺时针，屏幕坐标 y 向下）。
 * 用点列而不是直接画 rect，是因为这些点要参与三维变换。
 */
function crossSection(hw: number, hh: number, radius: number): Point2[] {
  const r = Math.max(0, Math.min(radius, hw, hh));
  const corners: { cx: number; cy: number; from: number }[] = [
    { cx: hw - r, cy: -(hh - r), from: -Math.PI / 2 }, // 右上
    { cx: hw - r, cy: hh - r, from: 0 }, // 右下
    { cx: -(hw - r), cy: hh - r, from: Math.PI / 2 }, // 左下
    { cx: -(hw - r), cy: -(hh - r), from: Math.PI }, // 左上
  ];

  const points: Point2[] = [];
  for (const corner of corners) {
    for (let i = 0; i <= CORNER_STEPS; i += 1) {
      const a = corner.from + (i / CORNER_STEPS) * (Math.PI / 2);
      points.push({ x: corner.cx + Math.cos(a) * r, y: corner.cy + Math.sin(a) * r });
    }
  }
  return points;
}

export function renderInfinityFrame(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  { tiltX, tiltY }: InfinityOptions,
): number {
  const w = Math.max(4, Math.round(width));
  const h = Math.max(4, Math.round(height));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) return 0;

  ctx.clearRect(0, 0, w, h);

  // 卡片在三维空间里的位置：镜头在原点朝 +Z 看，卡面（最外层）在 z = z0 处。
  // 取 z0 为长边的 0.95 倍，角落旋转 45° 时也不会穿到镜头后面。
  const z0 = Math.max(w, h) * 0.95;
  const focal = z0; // 让最外层在正视时正好铺满卡片
  const cx = w / 2;
  const cy = h / 2;

  const hw = (w / 2) * 0.93;
  const hh = (h / 2) * 0.93;
  // 卡片圆角 14px（--skin-radius），按比例换成像素，保证内层和外层圆角一致
  const radiusPx = Math.min(hw, hh) * 0.12;
  const section = crossSection(hw, hh, radiusPx);

  // 注意符号：本文件的 +Z 是"往画面里"，CSS 的 +Z 是"朝观看者"，
  // 同一个旋转矩阵在两套坐标里视觉效果正好镜像。要跟着卡片转，
  // 偏航取反、俯仰取正才是同一个方向（反了会像"卡片右转、内景左转"）。
  const yaw = -tiltX * MAX_YAW;
  const pitch = tiltY * MAX_PITCH;
  const cosY = Math.cos(yaw);
  const sinY = Math.sin(yaw);
  const cosP = Math.cos(pitch);
  const sinP = Math.sin(pitch);

  /**
   * 世界坐标（相对卡面中心）→ 屏幕坐标。
   * 先绕 Y 轴偏航、再绕 X 轴俯仰（**绕卡面中心**旋转，等价于人手把卡片转了个角度），
   * 然后做透视除法。z <= near 的点视为在镜头后面，返回 null。
   */
  const project = (p: Point3): Point2 | null => {
    const x1 = p.x * cosY + p.z * sinY;
    const z1 = -p.x * sinY + p.z * cosY;
    const y2 = p.y * cosP - z1 * sinP;
    const z2 = p.y * sinP + z1 * cosP;
    const zc = z0 + z2;
    if (zc <= 8) return null;
    const k = focal / zc;
    return { x: cx + x1 * k, y: cy + y2 * k };
  };

  /** 第 layer 层的整圈投影点；有一半点在镜头后就当这层不可见 */
  const projectLayer = (layer: number): (Point2 | null)[] => {
    const dz = layer * DEPTH_STEP * z0;
    return section.map((p) => project({ x: p.x, y: p.y, z: dz }));
  };

  /* ---------------------------------------------------------------- 底色 */
  const base = ctx.createLinearGradient(0, 0, w * 0.3, h);
  base.addColorStop(0, '#05070f');
  base.addColorStop(0.55, '#061225');
  base.addColorStop(1, '#03040a');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, w, h);

  // 盒子里透出来的整体微光：没有它，正对时只剩一堆线，像工程图不像镜子
  const ambient = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(w, h) * 0.52);
  ambient.addColorStop(0, 'rgba(96, 176, 255, 0.17)');
  ambient.addColorStop(0.55, 'rgba(48, 108, 196, 0.07)');
  ambient.addColorStop(1, 'rgba(18, 46, 104, 0)');
  ctx.fillStyle = ambient;
  ctx.fillRect(0, 0, w, h);

  // 层数：亮度衰减到 1.5% 就停，省下半截看不见的绘制
  let layers = 1;
  while (layers < MAX_LAYERS && Math.pow(REFLECTANCE, layers) > 0.015) layers += 1;

  const projected: (Point2 | null)[][] = [];
  for (let i = 0; i < layers; i += 1) projected.push(projectLayer(i));

  // 尽头那点光：最里面一层中心的辉光 + 一条窄亮的竖缝。
  // **画在所有侧壁之前**——它是最远的东西，斜看时应该被近处的壁挡住，
  // 画在最后就会浮在最上层，一眼假。
  const deepestGlow = project({ x: 0, y: 0, z: (layers - 1) * DEPTH_STEP * z0 });
  if (deepestGlow) {
    const glowR = Math.max(4, Math.min(w, h) * 0.16);
    const glow = ctx.createRadialGradient(deepestGlow.x, deepestGlow.y, 0, deepestGlow.x, deepestGlow.y, glowR);
    glow.addColorStop(0, 'rgba(238, 251, 255, 0.55)');
    glow.addColorStop(0.35, 'rgba(160, 225, 255, 0.18)');
    glow.addColorStop(1, 'rgba(80, 160, 255, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(deepestGlow.x - glowR, deepestGlow.y - glowR, glowR * 2, glowR * 2);

    const slitW = Math.max(1.2, w * 0.006);
    const slitH = Math.max(4, h * 0.05);
    ctx.fillStyle = 'rgba(246, 253, 255, 0.85)';
    ctx.fillRect(deepestGlow.x - slitW / 2, deepestGlow.y - slitH / 2, slitW, slitH);
  }

  /* -------------------------------------------------- 内侧壁 + 灯环：由远及近 */
  // 画法：从最里面一层往外画，越近的越后画 —— 近层自然盖住远层，
  // 于是斜着看只剩最前面几层（真实的遮挡关系，不是靠透明度装的）。
  for (let layer = layers - 1; layer >= 1; layer -= 1) {
    const far = projected[layer];
    const near = projected[layer - 1];
    if (!far || !near) continue;

    const brightness = Math.pow(REFLECTANCE, layer);
    const nearBrightness = Math.pow(REFLECTANCE, layer - 1);

    // 侧壁：连接第 layer-1 层与第 layer 层的对应采样点
    for (let j = 0; j < section.length; j += 1) {
      const a = near[j];
      const b = near[(j + 1) % section.length];
      const c = far[(j + 1) % section.length];
      const d = far[j];
      if (!a || !b || !c || !d) continue;

      // 用截面上这一小段的"高度"做明暗：上壁接光多、下壁最暗；
      // 再乘上"远端更暗"——同一段侧壁从近端到远端必须变暗，否则整条廊道像纸片
      const midY = (section[j]!.y + section[(j + 1) % section.length]!.y) / 2;
      const facing = 0.45 + 0.55 * (1 - (midY + hh) / (2 * hh));
      const shade = Math.min(1, nearBrightness * facing * (0.55 + 0.45 * brightness));

      const r = Math.round(3 + 12 * shade);
      const g = Math.round(8 + 30 * shade);
      const bl = Math.round(18 + 54 * shade);

      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.lineTo(c.x, c.y);
      ctx.lineTo(d.x, d.y);
      ctx.closePath();
      ctx.fillStyle = `rgb(${r}, ${g}, ${bl})`;
      ctx.fill();
    }

    // 灯环（这一层的 LED）：近层亮、远层暗，宽度也跟着透视缩
    const ring = near;
    const width = Math.max(0.5, 2.4 * Math.pow(nearBrightness, 0.6));
    const alpha = Math.min(1, 0.96 * Math.pow(nearBrightness, 0.6));

    ctx.beginPath();
    let started = false;
    for (const p of ring) {
      if (!p) continue;
      if (!started) {
        ctx.moveTo(p.x, p.y);
        started = true;
      } else {
        ctx.lineTo(p.x, p.y);
      }
    }
    if (started) {
      ctx.closePath();
      ctx.lineJoin = 'round';
      // 宽而淡的光晕 + 窄而亮的芯线，代替 shadowBlur（后者每帧上百次会掉帧）
      ctx.lineWidth = width * 5;
      ctx.strokeStyle = `rgba(120, 210, 255, ${alpha * 0.2})`;
      ctx.stroke();
      ctx.lineWidth = width;
      ctx.strokeStyle = `rgba(232, 250, 255, ${alpha})`;
      ctx.stroke();
      // 最里面一道白芯：LED 在照片里几乎过曝，只有一条细白线，缺了它整串灯是灰的
      ctx.lineWidth = Math.max(0.4, width * 0.42);
      ctx.strokeStyle = `rgba(255, 255, 255, ${Math.min(1, alpha * 1.05)})`;
      ctx.stroke();
    }
  }

  /* ------------------------------------------------------------ 玻璃质感 */
  // 斜向高光条：卡面上的反光，跟三维廊道无关，所以固定不随视角动
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  const gloss = ctx.createLinearGradient(w * 0.1, 0, w * 0.9, h);
  gloss.addColorStop(0, 'rgba(200, 235, 255, 0.12)');
  gloss.addColorStop(0.34, 'rgba(255, 255, 255, 0.02)');
  gloss.addColorStop(0.62, 'rgba(150, 205, 255, 0.1)');
  gloss.addColorStop(1, 'rgba(255, 255, 255, 0.02)');
  ctx.fillStyle = gloss;
  ctx.fillRect(0, 0, w, h);

  ctx.translate(w * 0.32, h * 0.22);
  ctx.rotate(-0.32);
  const streak = ctx.createLinearGradient(0, -h * 0.05, 0, h * 0.05);
  streak.addColorStop(0, 'rgba(255, 255, 255, 0)');
  streak.addColorStop(0.5, 'rgba(228, 248, 255, 0.1)');
  streak.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = streak;
  ctx.fillRect(-w, -h * 0.05, w * 2, h * 0.1);
  ctx.restore();

  // 文字压暗：上下各一层冷黑。廊道最亮的位置在中央，斜看时侧壁又会铺满上半张卡，
  // 不压这两条，名字和数值都会被灯带糊掉。
  const topScrim = ctx.createLinearGradient(0, 0, 0, h * 0.3);
  topScrim.addColorStop(0, 'rgba(3, 7, 16, 0.42)');
  topScrim.addColorStop(1, 'rgba(3, 7, 16, 0)');
  ctx.fillStyle = topScrim;
  ctx.fillRect(0, 0, w, h * 0.3);

  const scrim = ctx.createLinearGradient(0, h * 0.42, 0, h);
  scrim.addColorStop(0, 'rgba(3, 7, 16, 0)');
  scrim.addColorStop(0.42, 'rgba(3, 7, 16, 0.3)');
  scrim.addColorStop(1, 'rgba(2, 5, 12, 0.56)');
  ctx.fillStyle = scrim;
  ctx.fillRect(0, h * 0.42, w, h * 0.58);

  // 暗角
  const vignette = ctx.createRadialGradient(cx, cy * 0.8, Math.min(w, h) * 0.2, cx, cy, Math.max(w, h) * 0.78);
  vignette.addColorStop(0, 'rgba(0, 0, 0, 0)');
  vignette.addColorStop(0.7, 'rgba(0, 0, 0, 0.26)');
  vignette.addColorStop(1, 'rgba(0, 0, 0, 0.6)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, w, h);

  return 0;
}
