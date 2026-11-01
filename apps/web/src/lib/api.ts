/** 极简 API 客户端：同源请求 + 自动带 CSRF 头 + 统一错误对象 */

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
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
    | { data?: unknown; error?: { code: string; message: string } }
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
}

/** 评分构成里的一项（段位 / 社区出勤） */
export interface RatingComponent {
  key: 'RANK' | 'COMMUNITY' | string;
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
    bio?: string | null;
    qqNumber?: string | null;
    role: 'PLAYER' | 'ADMIN';
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
