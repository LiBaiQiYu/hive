/**
 * 报名到点自动截止 → 自动封盘 → 自动分队 → 自动发布。
 *
 * 为什么要有这一段：`registration_closes_at` 原本只作用于"能不能再报名"
 * （POST /registrations 会拒绝），但赛事状态还挂在 REGISTRATION_OPEN，
 * 要等管理员手动点「关闭报名 → 封盘 → 生成阵容 → 发布」四步。
 * 结果就是到了截止时间，12 个报名的人还在干等，谁进候补也没人知道。
 *
 * 关键取舍：**到点就等于管理员做了"按现有人数开局"的选择**。
 * 所以这里直接走 `START_PARTIAL`，不再弹 POLICY_REQUIRED 让人现场选
 * （管理员手动封盘那条路径仍然会问 START_PARTIAL / EXTEND / CANCEL）。
 * 想改期就在截止前手动改时间或点「封盘 → 延期」。
 *
 * 人数不足 10 人时无法开赛：只关闭报名并留一条审计，等管理员延期或取消——
 * 自动取消一场赛事风险太大（有人可能正在拉人）。
 */
import { newId } from '@hive/shared';
import type { Env } from '../env';
import { planFinalize, MATCH_SIZE, type FinalizeOutcome } from './roster';
import { benchToWaitlist } from './finalize';
import { generateMatchLineup, publishMatch } from './lineup';
import { notifyEventFinalized } from './notify';

export interface AutoCloseSummary {
  eventId: string;
  title: string;
  confirmed: number;
  /** 关闭后的最终结果：EXACT / START_PARTIAL / INSUFFICIENT */
  outcome: FinalizeOutcome;
  /** 生成并发布的场次数 */
  matches: number;
  /** 进候补的人数 */
  benched: number;
  /** 有邮箱、将来能收到通知的人数（通道未接通，sent 恒为 0） */
  withEmail: number;
  /** 单场失败时的原因；全部成功时为 null */
  error: string | null;
}

/** 系统动作的审计：actor_id 为空，actor_role = SYSTEM */
async function systemAudit(
  env: Env,
  action: string,
  entityId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit_logs (id, actor_id, actor_role, action, entity_type, entity_id,
       after_json, created_at)
     VALUES (?, NULL, 'SYSTEM', ?, 'event', ?, ?, ?)`,
  )
    .bind(newId(), action, entityId, JSON.stringify(payload), Date.now())
    .run();
}

/**
 * 扫一遍到点的赛事并跑完整条流水线。每次最多处理 5 场，
 * 让单次 Cron 的执行时间可控（免费版 CPU 有限，生成阵容本身要枚举 126 种分队）。
 */
export async function closeDueRegistrations(
  env: Env,
  now: number = Date.now(),
): Promise<AutoCloseSummary[]> {
  const due = await env.DB.prepare(
    `SELECT id, title, capacity, created_by AS createdBy FROM events
      WHERE status = 'REGISTRATION_OPEN'
        AND registration_closes_at IS NOT NULL
        AND registration_closes_at <= ?
      ORDER BY registration_closes_at ASC
      LIMIT 5`,
  )
    .bind(now)
    .all<{ id: string; title: string; capacity: number; createdBy: string }>();

  const summaries: AutoCloseSummary[] = [];
  for (const event of due.results ?? []) {
    summaries.push(await closeOne(env, event, now));
  }
  return summaries;
}

async function closeOne(
  env: Env,
  event: { id: string; title: string; capacity: number; createdBy: string },
  now: number,
): Promise<AutoCloseSummary> {
  // 守卫写在 UPDATE 里：并发的两个 Cron（或管理员刚好同时点）只有一个能改动状态
  const closed = await env.DB.prepare(
    `UPDATE events SET status = 'REGISTRATION_CLOSED', updated_at = ?
      WHERE id = ? AND status = 'REGISTRATION_OPEN'`,
  )
    .bind(now, event.id)
    .run();

  const counts = await env.DB.prepare(
    `SELECT
       (SELECT count(*) FROM registrations WHERE event_id = ? AND status = 'CONFIRMED') AS confirmed,
       (SELECT count(*) FROM registrations WHERE event_id = ? AND status = 'WAITLIST') AS waitlisted`,
  )
    .bind(event.id, event.id)
    .first<{ confirmed: number; waitlisted: number }>();

  const confirmed = counts?.confirmed ?? 0;
  const summary: AutoCloseSummary = {
    eventId: event.id,
    title: event.title,
    confirmed,
    outcome: 'INSUFFICIENT',
    matches: 0,
    benched: 0,
    withEmail: 0,
    error: null,
  };

  // 状态已经被别人改过：不重复处理（另一个 tick 或管理员已经动手了）
  if ((closed.meta.changes ?? 0) === 0) return summary;

  await systemAudit(env, 'event.auto-close', event.id, {
    confirmed,
    waitlisted: counts?.waitlisted ?? 0,
  });

  const decision = planFinalize(confirmed, event.capacity, 'START_PARTIAL', true);
  summary.outcome = decision.outcome;

  if (decision.outcome === 'INSUFFICIENT') {
    // 关掉报名但不猜"取消还是延期"：留给管理员决定
    await systemAudit(env, 'event.auto-finalize', event.id, {
      outcome: decision.outcome,
      confirmed,
      required: MATCH_SIZE,
    });
    return summary;
  }

  if (decision.outcome === 'START_PARTIAL') {
    summary.benched = await benchToWaitlist(env, event.id, decision.playCount, now);
  }

  for (let matchNo = 1; matchNo <= decision.matches; matchNo += 1) {
    try {
      const generated = await generateMatchLineup(
        env,
        { id: event.id, status: 'REGISTRATION_CLOSED' },
        {
          matchNo,
          // matches.created_by 是 NOT NULL 外键，系统任务没有"人"可填，
          // 记在赛事创建者名下（谁开的赛事谁负责这几场），审计里仍然是 SYSTEM。
          actor: { id: event.createdBy, role: 'SYSTEM' },
        },
      );
      await publishMatch(env, generated.matchId, { id: null, role: 'SYSTEM' }, null);
      summary.matches += 1;
    } catch (err) {
      // 一场失败不该带走整场赛事：记下原因，剩下的场次继续
      summary.error = err instanceof Error ? err.message : String(err);
      console.log(
        '[hive] 自动分队失败',
        JSON.stringify({ eventId: event.id, matchNo, error: summary.error }),
      );
      break;
    }
  }

  await systemAudit(env, 'event.auto-finalize', event.id, {
    outcome: decision.outcome,
    confirmed,
    playCount: decision.playCount,
    benchCount: decision.benchCount,
    matches: summary.matches,
    error: summary.error,
  });

  try {
    const notice = await notifyEventFinalized(env, {
      eventId: event.id,
      eventTitle: event.title,
      playCount: decision.playCount,
      benchCount: decision.benchCount,
      matches: summary.matches,
      trigger: 'AUTO',
    });
    summary.withEmail = notice.withEmail;
  } catch (err) {
    console.log(
      '[hive] 通知失败',
      JSON.stringify({ eventId: event.id, error: err instanceof Error ? err.message : String(err) }),
    );
  }

  return summary;
}
