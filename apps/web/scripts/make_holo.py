"""Generate the two holographic layers used by the holo card material.

- card-holo-foil.svg   : the iridescent film itself (soft multi-hue blobs)
- card-holo-facets.svg : the micro-diamond facet mesh (irregular triangles,
                         each with its own hue / brightness / edge highlight)

Both are transparent PNG-like layers stacked by CSS, so the dark metal base,
the foil, the facets, the rim and the resin gloss stay independent.
"""

import math
import random
import pathlib

OUT = pathlib.Path(r"C:\Users\62507\Desktop\hive\apps\web\src\assets")
W, H = 320, 240

PALETTE = ["#A7F5D0", "#8CEBEB", "#8CB9FF", "#B6A2FF", "#F3B9F5", "#F5F0A5"]


def foil() -> str:
    rng = random.Random(20231101)
    blobs = []
    # 大块柔和色斑：彼此叠加，形成"不同区域不同颜色"的薄膜感
    for _ in range(9):
        cx, cy = rng.uniform(-20, W + 20), rng.uniform(-20, H + 20)
        rx, ry = rng.uniform(90, 190), rng.uniform(70, 150)
        color = rng.choice(PALETTE)
        opacity = rng.uniform(0.28, 0.55)
        rot = rng.uniform(0, 180)
        blobs.append(
            f'<ellipse cx="{cx:.0f}" cy="{cy:.0f}" rx="{rx:.0f}" ry="{ry:.0f}"'
            f' fill="url(#blob-{color[1:]})" opacity="{opacity:.2f}"'
            f' transform="rotate({rot:.0f} {cx:.0f} {cy:.0f})"/>'
        )

    grads = []
    for color in PALETTE:
        grads.append(
            f'<radialGradient id="blob-{color[1:]}">'
            f'<stop offset="0" stop-color="{color}" stop-opacity="0.9"/>'
            f'<stop offset="0.55" stop-color="{color}" stop-opacity="0.45"/>'
            f'<stop offset="1" stop-color="{color}" stop-opacity="0"/>'
            "</radialGradient>"
        )

    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}">'
        f"<defs>{''.join(grads)}</defs>"
        + "".join(blobs)
        + "</svg>\n"
    )


def facets() -> str:
    rng = random.Random(9137)
    cell = 24
    tris = []
    for gy in range(-cell, H + cell, cell):
        for gx in range(-cell, W + cell, cell):
            pts = [
                (gx + rng.uniform(-7, 7), gy + rng.uniform(-7, 7)),
                (gx + cell + rng.uniform(-7, 7), gy + rng.uniform(-7, 7)),
                (gx + cell + rng.uniform(-7, 7), gy + cell + rng.uniform(-7, 7)),
                (gx + rng.uniform(-7, 7), gy + cell + rng.uniform(-7, 7)),
            ]
            for tri in ((0, 1, 2), (0, 2, 3)):
                p = " ".join(f"{pts[i][0]:.1f},{pts[i][1]:.1f}" for i in tri)
                color = rng.choice(PALETTE)
                # 大部分切面很淡（透出下面的薄膜），少数是亮面/暗面
                roll = rng.random()
                if roll < 0.1:
                    fill, opacity = "#ffffff", rng.uniform(0.12, 0.24)
                elif roll < 0.2:
                    fill, opacity = "#08111a", rng.uniform(0.1, 0.2)
                else:
                    fill, opacity = color, rng.uniform(0.18, 0.36)
                tris.append(
                    f'<polygon points="{p}" fill="{fill}" fill-opacity="{opacity:.2f}"'
                    f' stroke="#ffffff" stroke-opacity="0.2" stroke-width="0.45"/>'
                )

    # 少量高光点，模拟切面边缘的镜面反射
    glints = []
    for _ in range(14):
        x, y = rng.uniform(0, W), rng.uniform(0, H)
        r = rng.uniform(0.8, 2.2)
        glints.append(
            f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r:.1f}" fill="#ffffff"'
            f' fill-opacity="{rng.uniform(0.35, 0.8):.2f}"/>'
        )

    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}">'
        + "".join(tris)
        + "".join(glints)
        + "</svg>\n"
    )


if __name__ == "__main__":
    (OUT / "card-holo-foil.svg").write_text(foil(), encoding="utf-8")
    (OUT / "card-holo-facets.svg").write_text(facets(), encoding="utf-8")
    print("foil bytes:", (OUT / "card-holo-foil.svg").stat().st_size)
    print("facets bytes:", (OUT / "card-holo-facets.svg").stat().st_size)
