/**
 * 赛事编辑与候补转正的纯逻辑层。
 *
 * 这里刻意不碰数据库：所有"能不能改/能不能转正"的判断都写成纯函数，
 * 路由只负责读库、调用、落库。这样规则可以单测，也不会散落在 SQL 里。
 */
import { ApiError } from '@hive/shared';

export interface EventEditable {
  status: string;
  capacity: number;
  registration_opens_at: number | null;
  registration_closes_at: number | null;
  starts_at: number | null;
}

export interface EventPatch {
  title?: string;
  summary?: string | null;
  capacity?: number;
  registrationOpensAt?: number | null;
  registrationClosesAt?: number | null;
  startsAt?: number | null;
}

/**
 * 只有这两个状态下才允许改容量与赛程：
 * 关闭报名之后，封盘/分队已经按当时的 capacity 与时间做了决策，改了就前后不一致。
 * 标题与简介不受限制（改错别字不影响任何已落库的决策）。
 */
const SCHEDULE_EDITABLE = new Set(['DRAFT', 'REGISTRATION_OPEN']);

export interface EventTimes {
  capacity: number;
  opensAt: number | null;
  closesAt: number | null;
  startsAt: number | null;
}

/** 把 patch 合并进当前值，并校验不变量。非法输入一律抛 ApiError，不做"尽力而为"。 */
export function planEventUpdate(
  current: EventEditable,
  patch: EventPatch,
  confirmedCount: number,
): EventTimes {
  const touchesSchedule =
    patch.capacity !== undefined ||
    patch.registrationOpensAt !== undefined ||
    patch.registrationClosesAt !== undefined ||
    patch.startsAt !== undefined;

  if (touchesSchedule && !SCHEDULE_EDITABLE.has(current.status)) {
    throw new ApiError('CONFLICT', `赛事处于 ${current.status}，不能修改容量或赛程`);
  }

  const capacity = patch.capacity ?? current.capacity;
  if (capacity % 10 !== 0) {
    throw new ApiError('VALIDATION_FAILED', '容量必须是 10 的整数倍');
  }
  if (capacity < confirmedCount) {
    throw new ApiError('CONFLICT', `容量不能低于已确认人数（当前 ${confirmedCount} 人）`);
  }

  const opensAt =
    patch.registrationOpensAt === undefined ? current.registration_opens_at : patch.registrationOpensAt;
  const closesAt =
    patch.registrationClosesAt === undefined ? current.registration_closes_at : patch.registrationClosesAt;
  const startsAt = patch.startsAt === undefined ? current.starts_at : patch.startsAt;

  if (opensAt !== null && closesAt !== null && closesAt <= opensAt) {
    throw new ApiError('VALIDATION_FAILED', '报名截止时间必须晚于开始时间');
  }

  return { capacity, opensAt, closesAt, startsAt };
}

/** 能改标题/简介的状态：除了已归档/已取消，都允许（错别字修正不应被状态卡住）。 */
export function assertTitleEditable(current: EventEditable): void {
  if (current.status === 'ARCHIVED' || current.status === 'CANCELLED') {
    throw new ApiError('CONFLICT', `赛事处于 ${current.status}，不能再编辑`);
  }
}

export interface WaitlistEntry {
  id: string;
  position: number;
}

/**
 * 候补转正后重排剩余候补：保持原顺序，位置压缩成 1..n。
 * 不重排的话候补队列会出现 1,3,4 这样的空洞，前端展示和"下一位"语义都会错。
 */
export function compactWaitlist(rows: readonly WaitlistEntry[], promotedId: string): WaitlistEntry[] {
  return rows
    .filter((row) => row.id !== promotedId)
    .sort((a, b) => a.position - b.position)
    .map((row, index) => ({ id: row.id, position: index + 1 }));
}

export interface PromotableInput {
  eventStatus: string;
  registrationStatus: string;
  confirmedCount: number;
  capacity: number;
}

/** 候补转正的前置条件。四条全部服务端判断，前端按钮只是提示。 */
export function assertPromotable(input: PromotableInput): void {
  if (input.eventStatus !== 'REGISTRATION_OPEN' && input.eventStatus !== 'REGISTRATION_CLOSED') {
    throw new ApiError('CONFLICT', `赛事处于 ${input.eventStatus}，不能调整报名状态`);
  }
  if (input.registrationStatus !== 'WAITLIST') {
    throw new ApiError('CONFLICT', '只有候补名单里的报名可以转正');
  }
  if (input.confirmedCount >= input.capacity) {
    throw new ApiError(
      'CONFLICT',
      `正选已满（${input.confirmedCount}/${input.capacity}），请先提高容量或让正选退赛`,
    );
  }
}
