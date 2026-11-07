/** 极简 API 客户端：同源请求 + 自动带 CSRF 头 + 统一错误对象 */

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** 服务端 zod 的逐字段错误（field → 文案数组），表单可以就地标红而不是弹一句笼统提示 */
    readonly fields?: Record<string, string[]>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** 只认 { field: string[] } 这种形状；服务端的 details 别的接口可能塞任何东西 */
function readFieldErrors(details: unknown): Record<string, string[]> | undefined {
  if (!details || typeof details !== 'object') return undefined;
  const fields: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(details as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    const messages = value.filter((item): item is string => typeof item === 'string' && item !== '');
    if (messages.length > 0) fields[key] = messages;
  }
  return Object.keys(fields).length > 0 ? fields : undefined;
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface RequestOptions {
  method?: Method;
  body?: unknown;
  /**
   * 401 时不广播 hive:unauthorized。
   * 专门给「加载会话」用：游客调 /api/me 必然 401，那是正常状态，
   * 不该因此把人从首页踢到登录页。
   */
  silent401?: boolean;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  // 非 GET 请求必须带这个头：服务端用它挡跨站请求
  if (method !== 'GET') headers['x-hive-csrf'] = '1';

  const response = await fetch(`/api${path}`, {
    method,
    headers,
    credentials: 'include',
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const payload = (await response.json().catch(() => null)) as
    | { data?: unknown; error?: { code: string; message: string; details?: unknown } }
    | null;

  if (!response.ok) {
    // 会话在服务端失效（过期 / 别处登出）时，前端内存里可能还留着旧会话。
    // 这里只广播事件，清状态和跳转交给 session / router 处理，避免循环依赖。
    if (response.status === 401 && !options.silent401) {
      window.dispatchEvent(new CustomEvent('hive:unauthorized'));
    }
    throw new ApiError(
      payload?.error?.code ?? 'INTERNAL',
      payload?.error?.message ?? `请求失败（${response.status}）`,
      readFieldErrors(payload?.error?.details),
    );
  }
  return payload?.data as T;
}

/* ------------------------------------------------------------------ 类型 */

import type { CardSkin } from './cards';

export interface EventView {
  id: string;
  title: string;
  summary: string | null;
  format: string;
  teamSize: number;
  capacity: number;
  status: string;
  targetMatches: number;
  confirmed: number;
  waitlist: number;
  slotsToNextMatch: number | null;
  registrationOpensAt: number | null;
  registrationClosesAt: number | null;
  startsAt: number | null;
  /** 011 追加：赛事服务器。CN = 国服（蒸汽平台 / -perfectworld），GLOBAL = 全球服 */
  serverRegion: 'CN' | 'GLOBAL';
}

/** 评分构成里的一项（v3 只有天梯实力；RANK/COMMUNITY 是旧数据的兼容值） */
export interface RatingComponent {
  key: 'MMR' | 'RANK' | 'COMMUNITY' | string;
  weight: number;
  /** 0..1 */
  value: number;
  score: number;
  basis: string;
}

export interface RatingBreakdown {
  components: RatingComponent[];
  estimatedMmr: number | null;
  attendanceBp: number | null;
  attendancePlayed?: number | null;
  attendanceRegistered?: number | null;
}

export interface Rating {
  system: number;
  adjustment: number;
  effective: number;
  confidenceBp: number;
  uncertainty: number;
  algorithmVersion: string;
  /** 评分构成；老数据没有 breakdown_json 时为 null */
  breakdown: RatingBreakdown | null;
}

export interface Me {
  user: {
    id: string;
    username: string;
    displayName: string;
    /** 密码找回的收件地址；只有本人可见 */
    email?: string;
    /** 玩家有没有点过「我确认这个邮箱能收到信」；换邮箱会重置为 false */
    emailConfirmed?: boolean;
    bio?: string | null;
    qqNumber?: string | null;
    role: 'PLAYER' | 'ADMIN';
    /** 创始人：解锁创始人专属卡片材质（目前只有「无限镜」） */
    founder?: boolean;
    /** 注册时间（秒级时间戳），账号设置页用来展示"注册于" */
    createdAt?: number;
  };
  rating: Rating | null;
  /** 玩家自己选的卡片外观（材质 / 边框 / 特效） */
  cardSkin: CardSkin;
  positions: { position: number; rank: number; proficiency: number }[];
  gameAccount: {
    provider: string;
    verification: string;
    dotaAccountId: number;
    personaName: string | null;
    /** Steam / STRATZ 抓来的公开头像；没抓到就是 null */
    avatarUrl?: string | null;
    lastSyncedAt?: number | null;
  } | null;
  /** 外部同步来的段位数据；null 表示还没同步过 */
  stats: {
    rankTier: number | null;
    declaredMmr: number | null;
    rankSource: string | null;
    rankCheckedAt: number | null;
    careerMatches: number;
  } | null;
}

export const STATUS_LABEL: Record<string, string> = {
  DRAFT: '草稿',
  REGISTRATION_OPEN: '报名中',
  REGISTRATION_CLOSED: '报名截止',
  PUBLISHED: '阵容已发布',
  COMPLETED: '已结束',
  ARCHIVED: '已归档',
  CANCELLED: '已取消',
};

export function formatDate(ms: number | null): string {
  if (!ms) return '待定';
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
