/**
 * 镜面材质的环境色。
 *
 * 这里测的不是渲染（那是 WebGL2 的事，单测环境里没有 GPU），
 * 而是"同一个玩家永远是同一个颜色"和"段位决定副光"这两条约定——
 * 它们一旦漂移，同一个人在名单页和个人主页上会长得不一样。
 */
import { describe, expect, it } from 'vitest';
import { mirrorPalette, mirrorSeed } from './mirror';

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
