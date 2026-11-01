import { describe, expect, it } from 'vitest';
import { ApiError } from '@hive/shared';
import {
  assertPromotable,
  assertTitleEditable,
  compactWaitlist,
  planEventUpdate,
  type EventEditable,
} from './event-edit';

const event = (over: Partial<EventEditable> = {}): EventEditable => ({
  status: 'REGISTRATION_OPEN',
  capacity: 20,
  registration_opens_at: 1_000,
  registration_closes_at: 2_000,
  starts_at: 3_000,
  ...over,
});

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe(code);
    return;
  }
  throw new Error(`预期抛出 ${code}，但函数正常返回了`);
}

describe('planEventUpdate', () => {
  it('只改标题时，容量与时间原样保留', () => {
    expect(planEventUpdate(event(), { title: '新标题' }, 0)).toEqual({
      capacity: 20,
      opensAt: 1_000,
      closesAt: 2_000,
      startsAt: 3_000,
    });
  });

  it('报名截止早于开始 → VALIDATION_FAILED', () => {
    expectCode(
      () => planEventUpdate(event(), { registrationClosesAt: 500 }, 0),
      'VALIDATION_FAILED',
    );
  });

  it('清空截止时间（null）是合法的，不会和"没传"混淆', () => {
    const next = planEventUpdate(event(), { registrationClosesAt: null }, 0);
    expect(next.closesAt).toBeNull();
    expect(next.opensAt).toBe(1_000);
  });

  it('容量必须是 10 的整数倍', () => {
    expectCode(() => planEventUpdate(event(), { capacity: 15 }, 0), 'VALIDATION_FAILED');
  });

  it('容量不能低于已确认人数', () => {
    expectCode(() => planEventUpdate(event(), { capacity: 10 }, 12), 'CONFLICT');
    expect(planEventUpdate(event(), { capacity: 20 }, 20).capacity).toBe(20);
  });

  it('关闭报名后不能再改容量或赛程', () => {
    expectCode(
      () => planEventUpdate(event({ status: 'REGISTRATION_CLOSED' }), { capacity: 30 }, 0),
      'CONFLICT',
    );
    expectCode(
      () => planEventUpdate(event({ status: 'PUBLISHED' }), { startsAt: 9_000 }, 0),
      'CONFLICT',
    );
  });

  it('草稿期可以改赛程', () => {
    const next = planEventUpdate(event({ status: 'DRAFT' }), { startsAt: 8_000 }, 0);
    expect(next.startsAt).toBe(8_000);
  });
});

describe('assertTitleEditable', () => {
  it('进行中的赛事可以改标题', () => {
    expect(() => assertTitleEditable(event())).not.toThrow();
    expect(() => assertTitleEditable(event({ status: 'COMPLETED' }))).not.toThrow();
  });

  it('已归档 / 已取消的赛事不能改', () => {
    expectCode(() => assertTitleEditable(event({ status: 'ARCHIVED' })), 'CONFLICT');
    expectCode(() => assertTitleEditable(event({ status: 'CANCELLED' })), 'CONFLICT');
  });
});

describe('compactWaitlist', () => {
  const rows = [
    { id: 'a', position: 1 },
    { id: 'b', position: 2 },
    { id: 'c', position: 3 },
  ];

  it('提走中间一位后，后面的候补前移且不留空洞', () => {
    expect(compactWaitlist(rows, 'b')).toEqual([
      { id: 'a', position: 1 },
      { id: 'c', position: 2 },
    ]);
  });

  it('输入顺序打乱也按原位置重排', () => {
    const shuffled = [
      { id: 'c', position: 3 },
      { id: 'a', position: 1 },
      { id: 'b', position: 2 },
    ];
    expect(compactWaitlist(shuffled, 'a')).toEqual([
      { id: 'b', position: 1 },
      { id: 'c', position: 2 },
    ]);
  });

  it('队列空了返回空数组', () => {
    expect(compactWaitlist([{ id: 'a', position: 1 }], 'a')).toEqual([]);
  });
});

describe('assertPromotable', () => {
  const base = {
    eventStatus: 'REGISTRATION_OPEN',
    registrationStatus: 'WAITLIST',
    confirmedCount: 5,
    capacity: 20,
  };

  it('报名中、候补、未满员 → 允许', () => {
    expect(() => assertPromotable(base)).not.toThrow();
    expect(() => assertPromotable({ ...base, eventStatus: 'REGISTRATION_CLOSED' })).not.toThrow();
  });

  it('正选已满 → CONFLICT（capacity 是目标人数，不是座位数）', () => {
    expectCode(() => assertPromotable({ ...base, confirmedCount: 20 }), 'CONFLICT');
  });

  it('只有候补能转正', () => {
    expectCode(() => assertPromotable({ ...base, registrationStatus: 'CONFIRMED' }), 'CONFLICT');
    expectCode(() => assertPromotable({ ...base, registrationStatus: 'WITHDRAWN' }), 'CONFLICT');
  });

  it('已发布 / 已结束的赛事不能再动报名', () => {
    expectCode(() => assertPromotable({ ...base, eventStatus: 'PUBLISHED' }), 'CONFLICT');
    expectCode(() => assertPromotable({ ...base, eventStatus: 'CANCELLED' }), 'CONFLICT');
  });
});
