/**
 * 候补队列的优先级。
 *
 * 出勤是"可靠性"，不是"实力"：它不应该改变 WARROOM Rating，也不能影响分队；
 * 但它应该决定谁先补位。排序口径固定为：
 *
 *   1. 出勤率高的优先（没有记录按 50% 中性值，不奖励也不惩罚）
 *   2. 同出勤看实力分（报名时的快照）
 *   3. 再同分看报名时间（先到先得）
 *   4. id 兜底，保证结果确定
 *
 * 注意：这里只重排 WAITLIST 行。正选名单不按出勤筛选——谁先报名谁进正选，
 * 出勤只影响"临时补位"的顺序。
 */
import type { Env } from '../env';

export interface WaitlistPriorityRow {
  id: string;
  attendanceBp: number | null;
  effectiveRating: number;
  createdAt: number;
}

/** 没有出勤记录时的中性值：50% */
export const NEUTRAL_ATTENDANCE_BP = 5000;

function attendanceOf(row: WaitlistPriorityRow): number {
  return row.attendanceBp ?? NEUTRAL_ATTENDANCE_BP;
}

export function compareWaitlist(a: WaitlistPriorityRow, b: WaitlistPriorityRow): number {
  const attendance = attendanceOf(b) - attendanceOf(a);
  if (attendance !== 0) return attendance;

  if (a.effectiveRating !== b.effectiveRating) return b.effectiveRating - a.effectiveRating;
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id.localeCompare(b.id);
}

export function sortWaitlist<T extends WaitlistPriorityRow>(rows: readonly T[]): T[] {
  return [...rows].sort(compareWaitlist);
}

/**
 * 按最新出勤 / 评分快照重排某个赛事的全部候补，位置写回 1..n。
 * 报名进入候补、封盘把余数放进候补、转正、退赛之后都要调一次。
 */
export async function reorderWaitlist(env: Env, eventId: string): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT r.id,
            pr.attendance_bp AS attendanceBp,
            r.effective_rating_snapshot AS effectiveRating,
            r.created_at AS createdAt
       FROM registrations r
       LEFT JOIN player_ratings pr ON pr.user_id = r.user_id
      WHERE r.event_id = ? AND r.status = 'WAITLIST'`,
  )
    .bind(eventId)
    .all<WaitlistPriorityRow>();

  const ordered = sortWaitlist(rows.results ?? []);
  if (ordered.length === 0) return 0;

  const now = Date.now();
  await env.DB.batch(
    ordered.map((row, index) =>
      env.DB.prepare(
        `UPDATE registrations SET waitlist_position = ?, updated_at = ?
          WHERE id = ? AND status = 'WAITLIST'`,
      ).bind(index + 1, now, row.id),
    ),
  );

  return ordered.length;
}

/**
 * 出勤率变化（赛事结束、评分重算、算法升级）后，所有还在招募/待封盘的
 * 赛事候补队列都可能需要换序。数量很少，直接逐个重排。
 */
export async function reorderOpenEventWaitlists(env: Env): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT id FROM events WHERE status IN ('REGISTRATION_OPEN', 'REGISTRATION_CLOSED')`,
  ).all<{ id: string }>();

  let updated = 0;
  for (const row of rows.results ?? []) {
    updated += await reorderWaitlist(env, row.id);
  }
  return updated;
}
