import { reactive } from 'vue';
import { api, type Me } from './api';

/** 全局会话状态。规模这么小，不值得引入 Pinia */
export const session = reactive<{ me: Me | null; ready: boolean }>({
  me: null,
  ready: false,
});

export async function loadMe(): Promise<void> {
  try {
    session.me = await api<Me>('/me');
  } catch {
    session.me = null;
  } finally {
    session.ready = true;
  }
}

export async function logout(): Promise<void> {
  try {
    await api('/auth/logout', { method: 'POST' });
  } finally {
    session.me = null;
  }
}

// 任何请求收到 401（会话过期 / 在别的标签页退出），都把内存里的会话清掉，
// 否则导航和路由守卫会一直以为还登录着，页面停留在旧数据上。
if (typeof window !== 'undefined') {
  window.addEventListener('hive:unauthorized', () => {
    session.me = null;
  });
}
