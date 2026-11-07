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
import { sendMail, describeMailError, mailConfigured, explainMailError } from './mailer';

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
  /** 发送失败的封数（越界、地址无效、上游抽风都算） */
  failed?: number;
  /** 第一条失败原因，用来排查"为什么没收到" */
  error?: string;
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

/* ==========================================================================
 * 赛前提醒：开赛前的"该来了"邮件
 * ======================================================================== */

export interface EventStartingSoonNotice {
  eventId: string;
  eventTitle: string;
  /** 开赛时间（毫秒） */
  startsAt: number;
  confirmed: number;
  /** 赛事页地址，拼进正文 */
  eventUrl: string;
  /**
   * TEST = 只发给 extraRecipients（管理员自测，不打扰玩家）；
   * ALL  = 全体可收信的确认玩家 + extraRecipients。
   */
  mode: 'TEST' | 'ALL';
  /** 额外收件人：测试时就是管理员自己 */
  extraRecipients?: Array<{ email: string; displayName?: string }>;
  /** 谁点的发送：有值时审计记 ADMIN，否则记 SYSTEM */
  actorId?: string | null;
}

/** 免费版一次别发太多：每封都是一次子请求，20 封已经够一个社区用 */
const MAX_RECIPIENTS = 20;

const CST_OFFSET_MS = 8 * 3600_000;

/** 北京时间 `YYYY-MM-DD HH:mm`；不用 Intl，避免依赖运行时的 ICU 数据 */
export function formatCst(ms: number): string {
  const d = new Date(ms + CST_OFFSET_MS);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(
    d.getUTCHours(),
  )}:${pad(d.getUTCMinutes())}`;
}

export function buildStartingSoonMail(input: {
  displayName: string;
  eventTitle: string;
  startsAt: number;
  confirmed: number;
  eventUrl: string;
}): { subject: string; text: string } {
  const when = formatCst(input.startsAt);
  return {
    subject: `[HIVE] ${input.eventTitle} · ${when} 开赛提醒`,
    text: [
      `${input.displayName} 你好：`,
      '',
      `「${input.eventTitle}」将于 ${when}（北京时间）开赛，当前 ${input.confirmed} 人已确认。`,
      '',
      `查看名单与阵容：${input.eventUrl}`,
      '',
      '· 开赛前 10 分钟进语音频道，别让对方干等；',
      '· 临时来不了请在赛事页退赛，候补的人还在排队。',
      '',
      '—— HIVE（本邮件由系统自动发送，请勿直接回复）',
      '',
    ].join('\r\n'),
  };
}

/**
 * 赛前提醒。返回统计值：`sent` 是真正被 Cloudflare 接收的封数。
 *
 * 免费版只放行"已验证目的地地址"，其余会以 `E_RECIPIENT_NOT_ALLOWED` 失败——
 * 所以这里按人统计失败数与第一条原因，别让一个越界地址挡住整批。
 */
export async function notifyEventStartingSoon(
  env: Env,
  notice: EventStartingSoonNotice,
): Promise<NotifyResult> {
  const rows = await env.DB.prepare(
    `SELECT u.email AS email, u.display_name AS displayName
       FROM registrations r
       JOIN users u ON u.id = r.user_id
      WHERE r.event_id = ? AND r.status = 'CONFIRMED' AND u.status = 'ACTIVE'`,
  )
    .bind(notice.eventId)
    .all<{ email: string; displayName: string }>();

  const players = (rows.results ?? []).filter((row) => !isPlaceholderEmail(row.email));

  const seen = new Set<string>();
  const recipients: Array<{ email: string; displayName: string }> = [];
  const push = (email: string, displayName: string | undefined) => {
    const key = email.trim().toLowerCase();
    if (key.length === 0 || seen.has(key)) return;
    seen.add(key);
    recipients.push({ email: key, displayName: displayName?.trim() || key });
  };

  if (notice.mode === 'ALL') {
    for (const player of players) push(player.email, player.displayName);
  }
  for (const extra of notice.extraRecipients ?? []) {
    if (!isPlaceholderEmail(extra.email)) push(extra.email, extra.displayName);
  }

  const result: NotifyResult = {
    total: notice.mode === 'ALL' ? players.length : recipients.length,
    withEmail: recipients.length,
    sent: 0,
    failed: 0,
  };

  if (!mailConfigured(env)) {
    result.error = 'EMAIL_BINDING_MISSING';
  }

  for (const person of recipients.slice(0, MAX_RECIPIENTS)) {
    const mail = buildStartingSoonMail({
      displayName: person.displayName,
      eventTitle: notice.eventTitle,
      startsAt: notice.startsAt,
      confirmed: notice.confirmed,
      eventUrl: notice.eventUrl,
    });
    const sent = await sendMail(env, { to: person.email, ...mail });
    if (sent.ok) {
      result.sent += 1;
    } else {
      result.failed = (result.failed ?? 0) + 1;
      result.error ??= describeMailError(sent.error);
    }
  }

  // 给调用方（后台接口/审计）一句能直接照做的中文说明
  result.error = explainMailError(result.error);

  console.log('[hive] event.notify.starting_soon', JSON.stringify({ ...notice, ...result }));

  await env.DB.prepare(
    `INSERT INTO audit_logs (id, actor_id, actor_role, action, entity_type, entity_id,
       after_json, created_at)
     VALUES (?, ?, ?, 'event.notify', 'event', ?, ?, ?)`,
  )
    .bind(
      newId(),
      notice.actorId ?? null,
      notice.actorId ? 'ADMIN' : 'SYSTEM',
      notice.eventId,
      JSON.stringify({ kind: 'STARTING_SOON', ...notice, ...result }),
      Date.now(),
    )
    .run();

  return result;
}
