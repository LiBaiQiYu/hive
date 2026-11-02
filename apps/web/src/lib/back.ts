/**
 * 「返回上一页」的两个小工具：文案映射 + 从 history.state 里读来源路径。
 *
 * 为什么需要：玩家详情页可以从任何入口进来（排行榜、赛事报名名单、评论区、
 * 我的主页的「公开主页」……），返回按钮再固定指向某一个列表就是错的。
 * vue-router 每次导航都会把来源路径写进 `history.state.back`，
 * 站外进入（分享链接、新标签页）时它是 null —— 那时才回落到固定目标。
 */

/** 站内一级路径 → 「返回 + 目的地」里的目的地。没登记的路径一律「返回上一页」 */
const DESTINATIONS: Record<string, string> = {
  me: '我的主页',
  settings: '账号设置',
  leaderboard: '排行榜',
  players: '玩家主页',
  records: '战绩',
  events: '赛事',
  matches: '对局',
  admin: '后台',
};

/** 上一页路径 → 按钮文案；null（站外进入）时也返回「返回上一页」 */
export function backLabel(path: string | null | undefined): string {
  if (!path) return '返回上一页';
  const pathname = path.split(/[?#]/, 1)[0] ?? '';
  const segment = pathname.split('/').filter(Boolean)[0] ?? '';
  const destination = DESTINATIONS[segment];
  return destination ? `返回${destination}` : '返回上一页';
}

/**
 * 只认站内路径（以 / 开头）。历史里的值来自 history.state，
 * 别把 `javascript:` 之类的东西塞进 href。
 */
export function readBackPath(state: unknown): string | null {
  if (!state || typeof state !== 'object') return null;
  const back = (state as { back?: unknown }).back;
  return typeof back === 'string' && back.startsWith('/') ? back : null;
}
