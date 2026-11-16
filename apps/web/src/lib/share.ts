/**
 * 赛事分享：链接与文案由纯函数生成，方便单测，也保证列表里每张卡的
 * 文案格式完全一致（三段：标题+状态、时间、报名进度，最后一行是链接）。
 */
import { STATUS_LABEL, formatDate, type EventView } from './api';
import { serverLabel } from './server';

/**
 * 赛事详情页的绝对地址。
 * origin 由调用方传入而不是读 window：单测在 Node 里跑，没有 window。
 */
export function eventShareUrl(eventId: string, origin: string): string {
  return `${origin.replace(/\/+$/, '')}/events/${eventId}`;
}

/**
 * 一段可以直接贴进 QQ 群的文案。
 *
 * 不带倒计时（"还剩 3 小时"这种话在群里放两天就变成假消息），
 * 只写确定的两件事：报名截止、开赛时间。
 */
export function eventShareText(event: EventView, url: string): string {
  const status = STATUS_LABEL[event.status] ?? event.status;
  const lines = [`【${event.title}】${status} · 5v5 DOTA2`];

  if (event.registrationClosesAt) {
    lines.push(`报名截止：${formatDate(event.registrationClosesAt)}`);
  }
  if (event.startsAt) {
    lines.push(`开赛：${formatDate(event.startsAt)}`);
  }
  if (!event.registrationClosesAt && !event.startsAt) {
    lines.push('时间：待定');
  }

  lines.push(`${serverLabel(event.serverRegion)} · 已报名 ${event.confirmed}/${event.capacity} 人`);
  lines.push(url);
  return lines.join('\n');
}
