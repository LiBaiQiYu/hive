/**
 * 赛事通知（评审：先留接口，暂不发信）。
 *
 * 现状：报名截止、分组完成之后，系统**还发不了邮件**。
 * Cloudflare 免费版只能给"已验证目的地地址"发信（官方定价页原文：
 * *Sending to arbitrary recipients requires the Workers Paid plan*），
 * 要发信需要先做两件控制台操作：
 *   1. Compute → Email Service → Email Sending 里把 cwa1e.top 开通（加 MX/SPF/DKIM/DMARC）；
 *   2. 把每个收件箱加为 Destination address，让本人点一次确认信（免费版上限 200 个）。
 * 或者升级 Workers Paid（$5/月）后直接发给任意地址。
 *
 * 所以这里只做三件事：算出"该通知谁"、记一条审计、打一行结构化日志。
 * 通道定下来之后，只改这个文件里的 TODO，调用点（event-auto.ts 与后台手动封盘）不用动。
 */
import type { Env } from '../env';
import { newId } from '@hive/shared';

export interface EventFinalizedNotice {
  eventId: string;
  eventTitle: string;
  /** 留在正选的人数 */
  playCount: number;
  /** 进候补的人数 */
  benchCount: number;
  /** 生成并发布的场次数 */
  matches: number;
  /** 触发方式：到点自动 / 管理员手动 */
  trigger: 'AUTO' | 'MANUAL';
}

export interface NotifyResult {
  /** 该赛事里仍然有效报名的玩家数 */
  total: number;
  /** 其中有可用邮箱（能收信）的人数 */
  withEmail: number;
  /** 真的发出去了几封——通道没接上时恒为 0 */
  sent: number;
}

/** 占位地址：这些域名不可能是真邮箱 */
const PLACEHOLDER_DOMAINS = ['hive.local', 'hive.test', 'example.com', 'example.org', 'localhost'];

export function isPlaceholderEmail(email: string | null | undefined): boolean {
  if (!email) return true;
  const lower = email.trim().toLowerCase();
  if (lower.length === 0) return true;
  const at = lower.lastIndexOf('@');
  if (at <= 0) return true;
  return PLACEHOLDER_DOMAINS.includes(lower.slice(at + 1));
}

/**
 * 赛事截止 + 分组完成的通知。
 *
 * 返回统计值而不是"发送成功/失败"：在通道接上之前，调用方（Cron）拿到的
 * `sent` 永远是 0，`withEmail` 是"到时候能发给几个人"，用来给管理员一个预期。
 */
export async function notifyEventFinalized(
  env: Env,
  notice: EventFinalizedNotice,
): Promise<NotifyResult> {
  const rows = await env.DB.prepare(
    `SELECT u.email AS email
       FROM registrations r
       JOIN users u ON u.id = r.user_id
      WHERE r.event_id = ? AND r.status IN ('CONFIRMED', 'WAITLIST') AND u.status = 'ACTIVE'`,
  )
    .bind(notice.eventId)
    .all<{ email: string }>();

  const list = rows.results ?? [];
  const deliverable = list.filter((row) => !isPlaceholderEmail(row.email));
  const result: NotifyResult = {
    total: list.length,
    withEmail: deliverable.length,
    sent: 0,
  };

  // TODO(邮件通道)：这里接 env.EMAIL.send()，逐封或 BCC 批量发。
  // 免费版要逐个把地址加成"已验证目的地地址"，否则会抛 E_RECIPIENT_NOT_ALLOWED；
  // 接的时候记得按错误码分类统计，别让一个坏地址挡住整批。
  console.log('[hive] event.notice', JSON.stringify({ ...notice, ...result }));

  await env.DB.prepare(
    `INSERT INTO audit_logs (id, actor_id, actor_role, action, entity_type, entity_id,
       after_json, created_at)
     VALUES (?, NULL, 'SYSTEM', 'event.notify', 'event', ?, ?, ?)`,
  )
    .bind(
      newId(),
      notice.eventId,
      JSON.stringify({ ...notice, ...result }),
      Date.now(),
    )
    .run();

  return result;
}
