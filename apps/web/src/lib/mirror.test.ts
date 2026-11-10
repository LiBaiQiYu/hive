/**
 * 镜面材质的环境色。
 *
 * 这里测的不是渲染（那是 WebGL2 的事，单测环境里没有 GPU），
 * 而是"同一个玩家永远是同一个颜色"和"段位决定副光"这两条约定——
 * 它们一旦漂移，同一个人在名单页和个人主页上会长得不一样。
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MIRROR_PARAMS,
  MIRROR_PARAM_RANGES,
  getMirrorParams,
  mirrorPalette,
  mirrorSeed,
  normalizeMirrorParams,
  resetMirrorParams,
  setMirrorParams,
} from './mirror';

const KEYS = ['u-01a19047', 'u-01a1b1ab', 'u-01a1c000', 'u-01a1c001'];

describe('镜面环境色', () => {
  it('身份 hash 稳定且落在 0..1', () => {
    for (const key of KEYS) {
      const seed = mirrorSeed(key);
      expect(seed).toBe(mirrorSeed(key));
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThan(1);
    }
    expect(new Set(KEYS.map(mirrorSeed)).size).toBe(KEYS.length);
    expect(mirrorSeed('')).toBe(mirrorSeed(''));
  });

  it('金属本色接近中性：每个人只差一点点色相', () => {
    for (const key of KEYS) {
      const { tint } = mirrorPalette(key);
      for (const channel of tint) {
        expect(channel).toBeGreaterThan(0.6);
        expect(channel).toBeLessThan(1.05);
      }
      const spread = Math.max(...tint) - Math.min(...tint);
      expect(spread).toBeLessThan(0.3);
    }
  });

  it('副光跟着段位走，没填段位时用中性冷蓝', () => {
    const legend = mirrorPalette('u-1', 52); // 5 传奇
    const immortal = mirrorPalette('u-1', 80); // 8 冠绝
    expect(legend.accent).not.toEqual(immortal.accent);
    // 段位不影响金属本色，只影响副光
    expect(legend.tint).toEqual(immortal.tint);
    expect(mirrorPalette('u-1', null).accent).toEqual(mirrorPalette('u-1', 0).accent);
    expect(mirrorPalette('u-1', undefined).accent).toEqual(mirrorPalette('u-1', 0).accent);
    // 星级不参与取色：同一枚勋章 1 星和 5 星是同一块灯光
    expect(mirrorPalette('u-1', 51).accent).toEqual(mirrorPalette('u-1', 55).accent);
  });

  it('段位色都是合法的 0..1 三元组', () => {
    for (let tier = 10; tier <= 85; tier += 5) {
      const { accent } = mirrorPalette('u-2', tier);
      expect(accent).toHaveLength(3);
      for (const channel of accent) {
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('镜面可调参数', () => {
  it('脏值夹到区间里，缺的补默认值', () => {
    const params = normalizeMirrorParams({ curvY: 99, spanX: -5, sceneLod: Number.NaN });
    expect(params.curvY).toBe(MIRROR_PARAM_RANGES.curvY[1]);
    expect(params.spanX).toBe(MIRROR_PARAM_RANGES.spanX[0]);
    expect(params.sceneLod).toBe(DEFAULT_MIRROR_PARAMS.sceneLod);
    expect(normalizeMirrorParams(null)).toEqual(DEFAULT_MIRROR_PARAMS);
    expect(normalizeMirrorParams(undefined)).toEqual(DEFAULT_MIRROR_PARAMS);
    // localStorage 里可能被人塞进来别的类型
    expect(normalizeMirrorParams({ exposure: '1.5' as unknown as number }).exposure).toBe(
      DEFAULT_MIRROR_PARAMS.exposure,
    );
  });

  it('每个参数都有自己的区间，且默认值落在区间内', () => {
    for (const [key, range] of Object.entries(MIRROR_PARAM_RANGES)) {
      const [min, max] = range;
      expect(min).toBeLessThan(max);
      const value = DEFAULT_MIRROR_PARAMS[key as keyof typeof DEFAULT_MIRROR_PARAMS];
      expect(value).toBeGreaterThanOrEqual(min);
      expect(value).toBeLessThanOrEqual(max);
    }
  });

  it('set 之后 get 拿得到，reset 回到默认', () => {
    const before = getMirrorParams();
    try {
      const applied = setMirrorParams({ exposure: 1.4, spotX: 0.25 });
      expect(applied.exposure).toBeCloseTo(1.4, 6);
      expect(getMirrorParams().spotX).toBeCloseTo(0.25, 6);
    } finally {
      expect(resetMirrorParams()).toEqual(DEFAULT_MIRROR_PARAMS);
      // 别把状态留给同一进程里的其它用例
      setMirrorParams(before);
    }
  });
});
