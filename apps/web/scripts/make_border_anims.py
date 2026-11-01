"""生成卡片边框的逐帧动画（透明背景，按卡片比例 560×464，导出为 WebP 动图）。

和参考的 Steam 物品边框是同一套运动逻辑：
  spark 青蓝细轨：恒亮导轨 + 沿边巡游的高亮光团 + 边缘随机粒子
  arc   金色电弧：每帧重新抖动的锯齿电弧（25fps 重击感）
  frost 冰白细线：细线 + 很慢的冷光扫过 + 零星闪光
所有帧都是 RGBA 透明底，直接叠在卡片上，不遮挡内容。
"""

import math
import random
import pathlib

from PIL import Image, ImageDraw, ImageFilter

OUT = pathlib.Path(r"C:\Users\62507\Desktop\hive\apps\web\src\assets")
W, H = 480, 398
INSET = 10
RADIUS = 24
SCALE = 2  # 卡片 CSS 尺寸 280×232 的 2 倍（480×398 足够，再大只是白占内存）


def perimeter_points(inset=INSET, radius=RADIUS, step=6):
    """沿圆角矩形顺时针采样，返回 (x, y) 列表。"""
    pts = []
    x0, y0, x1, y1 = inset, inset, W - inset, H - inset

    def arc(cx, cy, a0, a1):
        n = max(4, int(abs(a1 - a0) * radius / 4))
        for i in range(n + 1):
            a = a0 + (a1 - a0) * i / n
            pts.append((cx + radius * math.cos(a), cy + radius * math.sin(a)))

    arc(x0 + radius, y0 + radius, math.pi, 1.5 * math.pi)
    arc(x1 - radius, y0 + radius, 1.5 * math.pi, 2 * math.pi)
    arc(x1 - radius, y1 - radius, 0, 0.5 * math.pi)
    arc(x0 + radius, y1 - radius, 0.5 * math.pi, math.pi)

    # 直边补采样
    dense = []
    for i in range(len(pts)):
        a, b = pts[i], pts[(i + 1) % len(pts)]
        dense.append(a)
        dist = math.hypot(b[0] - a[0], b[1] - a[1])
        count = int(dist // step)
        for k in range(1, count + 1):
            t = k / (count + 1)
            dense.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
    return dense


PERIM = perimeter_points()


def glow(layer: Image.Image, radius: float, strength: float) -> Image.Image:
    blurred = layer.filter(ImageFilter.GaussianBlur(radius))
    if strength < 1:
        alpha = blurred.split()[3].point(lambda v: int(v * strength))
        blurred.putalpha(alpha)
    return blurred


def frame_spark(t: float) -> Image.Image:
    """t: 0..1 循环进度"""
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    core = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(core)

    # 1. 导轨：亮度随光团位置轻微起伏
    rail_alpha = 120 + int(50 * math.sin(t * math.tau * 2))
    draw.line(PERIM + [PERIM[0]], fill=(120, 220, 255, rail_alpha), width=2, joint="curve")

    # 2. 沿边巡游的高亮光团（两个，相位差半圈）
    n = len(PERIM)
    for phase in (0.0, 0.5):
        head = int(((t + phase) % 1.0) * n)
        # 连续拖尾：沿边框画一串宽度和亮度渐变的线段，而不是离散圆点
        for j in range(-30, 2):
            idx = (head + j) % n
            nxt = (idx + 1) % n
            fade = max(0.0, 1 - abs(j) / 30.0) ** 1.6
            width = 1 + fade * 5
            alpha = int(255 * fade ** 1.4)
            draw.line(
                [PERIM[idx], PERIM[nxt]],
                fill=(215, 250, 255, alpha),
                width=max(1, int(width)),
            )

    # 3. 边缘随机粒子（固定种子 + 帧号，保证每次生成一致）
    rng = random.Random(int(t * 1000) + 17)
    for _ in range(14):
        idx = rng.randrange(n)
        p = PERIM[idx]
        jitter = rng.uniform(-6, 6)
        x = p[0] + rng.uniform(-5, 5)
        y = p[1] + rng.uniform(-5, 5)
        r = rng.uniform(0.8, 2.2)
        alpha = rng.randint(110, 255)
        draw.ellipse([x - r, y - r, x + r, y + r], fill=(190, 240, 255, alpha))
        del jitter

    img.alpha_composite(glow(core, 6, 0.55))
    img.alpha_composite(core)
    return img


def frame_arc(t: float, index: int) -> Image.Image:
    rng = random.Random(index * 7919 + 3)
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    core = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(core)

    # 三条错位的锯齿路径叠出"电弧"的粗细层次
    for width, color, alpha, amp in (
        (7, (255, 176, 64), 80, 5),
        (3, (255, 214, 130), 190, 3.5),
        (1, (255, 246, 214), 245, 2),
    ):
        pts = [
            (x + rng.uniform(-amp, amp), y + rng.uniform(-amp, amp))
            for x, y in PERIM
        ]
        draw.line(pts + [pts[0]], fill=color + (alpha,), width=width, joint="curve")

    # 偶尔一条跨角的短电弧
    if index % 5 == 0:
        a = PERIM[rng.randrange(len(PERIM))]
        b = (a[0] + rng.uniform(-60, 60), a[1] + rng.uniform(-60, 60))
        draw.line([a, b], fill=(255, 240, 190, 200), width=2)

    img.alpha_composite(glow(core, 6, 0.55))
    img.alpha_composite(core)
    return img


def frame_frost(t: float) -> Image.Image:
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    core = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(core)

    n = len(PERIM)
    # 细线：沿线方向做一道缓慢移动的亮度波
    for i in range(n):
        p = PERIM[i]
        wave = 0.5 + 0.5 * math.sin((i / n) * math.tau * 1.0 - t * math.tau)
        alpha = int(120 + 110 * wave)
        draw.rectangle([p[0] - 1, p[1] - 1, p[0] + 1, p[1] + 1], fill=(240, 250, 255, alpha))

    # 少量闪光点
    rng = random.Random(int(t * 1000) + 5)
    for _ in range(5):
        p = PERIM[rng.randrange(n)]
        r = rng.uniform(1.0, 2.4)
        a = rng.randint(160, 255)
        draw.ellipse([p[0] - r, p[1] - r, p[0] + r, p[1] + r], fill=(255, 255, 255, a))

    img.alpha_composite(glow(core, 5, 0.5))
    img.alpha_composite(core)
    return img


def save_anim(frames, path: pathlib.Path, fps: int, quality: int = 78):
    first, rest = frames[0], frames[1:]
    first.save(
        path,
        save_all=True,
        append_images=rest,
        duration=int(1000 / fps),
        loop=0,
        quality=quality,
        method=4,
    )
    print(f"{path.name}: {len(frames)} frames @{fps}fps -> {path.stat().st_size / 1024:.0f} KB")


def main():
    # 电光：5s 循环，12fps（参考是 30fps，但边框运动慢，12fps 足够且体积小）
    spark_frames = [frame_spark(i / 75) for i in range(75)]
    save_anim(spark_frames, OUT / "card-frame-spark.webp", fps=15)

    # 雷纹：1s 循环，12fps（参考 25fps 重击，12fps 已能看出抖动）
    arc_frames = [frame_arc(i / 15, i) for i in range(15)]
    save_anim(arc_frames, OUT / "card-frame-arc.webp", fps=15, quality=82)

    # 霜线：1s 循环，10fps
    frost_frames = [frame_frost(i / 10) for i in range(10)]
    save_anim(frost_frames, OUT / "card-frame-frost.webp", fps=10, quality=82)


if __name__ == "__main__":
    main()
