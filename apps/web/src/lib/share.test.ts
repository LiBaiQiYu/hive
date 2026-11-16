import { describe, expect, it } from 'vitest';
import type { EventView } from './api';
import { eventShareText, eventShareUrl } from './share';

const EVENT: EventView = {
  id: 'evt-1',
  title: 'HIVE 第 01 期周末内战',
  summary: null,
  format: '5v5',
  teamSize: 5,
  capacity: 20,
  status: 'REGISTRATION_OPEN',
  targetMatches: 2,
  confirmed: 12,
  waitlist: 2,
  slotsToNextMatch: 8,
  registrationOpensAt: null,
  registrationClosesAt: new Date(2026, 10, 15, 18, 0).getTime(),
  startsAt: new Date(2026, 10, 15, 20, 0).getTime(),
  serverRegion: 'GLOBAL',
};

describe('赛事分享', () => {
  it('链接指向赛事详情页，且不会因为 origin 末尾的斜杠出现双斜杠', () => {
    expect(eventShareUrl('evt-1', 'https://hive.cwa1e.top')).toBe(
      'https://hive.cwa1e.top/events/evt-1',
    );
    expect(eventShareUrl('evt-1', 'https://hive.cwa1e.top/')).toBe(
      'https://hive.cwa1e.top/events/evt-1',
    );
  });

  it('文案包含标题、状态、两个时间、报名进度与链接', () => {
    const text = eventShareText(EVENT, 'https://hive.cwa1e.top/events/evt-1');

    expect(text).toContain('【HIVE 第 01 期周末内战】报名中');
    expect(text).toContain('报名截止：11月15日 18:00');
    expect(text).toContain('开赛：11月15日 20:00');
    expect(text).toContain('全球服 · 已报名 12/20 人');
    expect(text.endsWith('https://hive.cwa1e.top/events/evt-1')).toBe(true);
  });

  it('没有时间时写「待定」，而不是留一行空的或省略成半句话', () => {
    const text = eventShareText(
      { ...EVENT, registrationClosesAt: null, startsAt: null },
      'https://hive.cwa1e.top/events/evt-1',
    );

    expect(text).toContain('时间：待定');
    expect(text).not.toContain('报名截止');
    expect(text).not.toContain('开赛：');
  });

  it('只有开赛时间时仍然给出报名截止的语义空缺（不伪造时间）', () => {
    const text = eventShareText(
      { ...EVENT, registrationClosesAt: null },
      'https://hive.cwa1e.top/events/evt-1',
    );

    expect(text).toContain('开赛：11月15日 20:00');
    expect(text).not.toContain('报名截止');
    expect(text).not.toContain('时间：待定');
  });
});
