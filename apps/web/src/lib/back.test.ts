import { describe, expect, it } from 'vitest';
import { backLabel, readBackPath } from './back';

describe('readBackPath', () => {
  it('取出 vue-router 写入的来源路径', () => {
    expect(readBackPath({ back: '/leaderboard', current: '/players/x' })).toBe('/leaderboard');
  });

  it('站外进入（没有 state / back 为 null）时返回 null', () => {
    expect(readBackPath(null)).toBeNull();
    expect(readBackPath(undefined)).toBeNull();
    expect(readBackPath({})).toBeNull();
    expect(readBackPath({ back: null })).toBeNull();
    expect(readBackPath('not-an-object')).toBeNull();
  });

  it('只接受站内路径，别把 javascript: 之类塞进 href', () => {
    expect(readBackPath({ back: 'javascript:alert(1)' })).toBeNull();
    expect(readBackPath({ back: 'https://evil.example/x' })).toBeNull();
    expect(readBackPath({ back: 42 })).toBeNull();
    expect(readBackPath({ back: '/events/e1?tab=roster#top' })).toBe('/events/e1?tab=roster#top');
  });
});

describe('backLabel', () => {
  it('按一级路径给「返回 + 目的地」', () => {
    expect(backLabel('/me')).toBe('返回我的主页');
    expect(backLabel('/leaderboard?sort=wins')).toBe('返回排行榜');
    expect(backLabel('/events/01a1/roster#top')).toBe('返回赛事');
    expect(backLabel('/players/abc')).toBe('返回玩家主页');
  });

  it('没登记的路径与站外进入都退回「返回上一页」', () => {
    expect(backLabel('/unknown/deep')).toBe('返回上一页');
    expect(backLabel('/')).toBe('返回上一页');
    expect(backLabel(null)).toBe('返回上一页');
    expect(backLabel('')).toBe('返回上一页');
  });
});
