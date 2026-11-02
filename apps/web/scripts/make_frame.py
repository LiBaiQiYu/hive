"""生成电弧边框 card-frame-arc.svg（金/琥珀色雷电纹，参考 Steam 物品边框）。"""

import math
import pathlib
import random

OUT = pathlib.Path(r"C:\Users\62507\Desktop\hive\apps\web\src\assets")
W, H = 320, 260
INSET = 10
R = 14


def rounded_rect_points(w, h, inset, r, step=16):
    """沿圆角矩形采样一圈点（顺时针）。"""
    pts = []
    x0, y0, x1, y1 = inset, inset, w - inset, h - inset

    def arc(cx, cy, a0, a1):
        n = max(3, int(abs(a1 - a0) / (math.pi / 10)))
        for i in range(n + 1):
            a = a0 + (a1 - a0) * i / n
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))

    arc(x0 + r, y0 + r, math.pi, 1.5 * math.pi)
    arc(x1 - r, y0 + r, 1.5 * math.pi, 2 * math.pi)
    arc(x1 - r, y1 - r, 0, 0.5 * math.pi)
    arc(x0 + r, y1 - r, 0.5 * math.pi, math.pi)

    # 边中点补点，防止直边被拉成折线
    full = []
    for i in range(len(pts)):
        a = pts[i]
        b = pts[(i + 1) % len(pts)]
        full.append(a)
        dist = math.hypot(b[0] - a[0], b[1] - a[1])
        extra = int(dist // step)
        for k in range(1, extra + 1):
            t = k / (extra + 1)
            full.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
    return full


def jagged(points, rng, amp):
    out = []
    for i, (x, y) in enumerate(points):
        if i % 2 == 0:
            out.append((x + rng.uniform(-amp, amp), y + rng.uniform(-amp, amp)))
        else:
            out.append((x, y))
    return out


def main():
    rng = random.Random(2023)
    base = rounded_rect_points(W, H, INSET, R, step=14)

    layers = []
    # 三层错开的电弧：外层宽而淡、中层亮、内层细
    for width, color, opacity, amp, scale in [
        (7, "#ffb347", 0.28, 3.2, 1.0),
        (3, "#ffd98a", 0.75, 2.4, 0.985),
        (1.3, "#fff6d8", 0.95, 1.6, 0.97),
    ]:
        pts = [
            (
                (x - W / 2) * scale + W / 2 + rng.uniform(-amp, amp),
                (y - H / 2) * scale + H / 2 + rng.uniform(-amp, amp),
            )
            for x, y in jagged(base, rng, amp)
        ]
        d = "M " + " L ".join(f"{x:.1f} {y:.1f}" for x, y in pts) + " Z"
        layers.append(
            f'<path d="{d}" fill="none" stroke="{color}" stroke-opacity="{opacity}"'
            f' stroke-width="{width}" stroke-linejoin="round" stroke-linecap="round"/>'
        )

    # preserveAspectRatio="none"：CSS 用 background-size: 100% 100% 铺满色片，
    # 不给它就会按 viewBox 比例居中留边（色片比 320×260 更扁，边框会缩在中间）
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" '
        'preserveAspectRatio="none">'
        "<defs>"
        '<filter id="glow" x="-20%" y="-20%" width="140%" height="140%">'
        '<feGaussianBlur stdDeviation="4"/>'
        "</filter>"
        "</defs>"
        f'<g filter="url(#glow)" opacity="0.55">{"".join(layers[:1])}</g>'
        + "".join(layers[1:])
        + "</svg>\n"
    )
    (OUT / "card-frame-arc.svg").write_text(svg, encoding="utf-8")
    print("arc bytes:", (OUT / "card-frame-arc.svg").stat().st_size)


if __name__ == "__main__":
    main()
