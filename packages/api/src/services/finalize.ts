/**
 * 封盘的"落库"部分：谁留下当正选、谁进候补。
 *
 * 这段 SQL 的顺序必须与 `services/roster.ts` 的 `compareForSelection` 完全一致，
 * 否则"管理员手动让位"和"自动挑选"会给出两套结果。单独放一个文件是为了让
 * 后台封盘（admin-events.ts）与到点自动封盘（event-auto.ts）共用同一份实现。
 */
import type { Env } from '../env';
import { reorderWaitlist } from './waitlist';

/**
 * 把排在 playCount 之后的正选挪进候补，返回被挪的人数。
 *
 * 顺序：有段位信息 → 报名评分降序 → 报名时间升序 → id 升序。
 * 段位看的是**实时** player_stats，不是报名快照：报名后补了段位就该算数。
 *
 * 全部 UPDATE 走一个 batch（事务），不会出现"改了一半"的中间态。
 */
export async function benchToWaitlist(
  env: Env,
  eventId: string,
  playCount: number,
  now: number = Date.now(),
): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT r.id FROM registrations r
       LEFT JOIN player_stats ps ON ps.user_id = r.user_id
      WHERE r.event_id = ? AND r.status = 'CONFIRMED'
      ORDER BY (CASE WHEN ps.rank_tier IS NOT NULL OR ps.declared_mmr IS NOT NULL THEN 1 ELSE 0 END) DESC,
               r.effective_rating_snapshot DESC, r.created_at ASC, r.id ASC`,
  )
    .bind(eventId)
    .all<{ id: string }>();

  const benched = (rows.results ?? []).slice(playCount);
  if (benched.length === 0) return 0;

  await env.DB.batch(
    benched.map((row, index) =>
      env.DB.prepare(
        `UPDATE registrations SET status = 'WAITLIST', waitlist_position = ?, updated_at = ?
          WHERE id = ? AND status = 'CONFIRMED'`,
      ).bind(index + 1, now, row.id),
    ),
  );

  // 位置只是临时值；真正的候补顺序由"出勤 → 实力 → 报名时间"决定
  await reorderWaitlist(env, eventId);
  return benched.length;
}
