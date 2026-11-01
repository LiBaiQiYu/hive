import { reactive } from 'vue';
import { api, type Me } from './api';

/** 全局会话状态。规模这么小，不值得引入 Pinia */
export const session = reactive<{ me: Me | null; ready: boolean }>({
  me: null,
  ready: false,
});

export async function loadMe(): Promise<void> {
  try {
    // 游客调用 /api/me 返回 401 是正常状态，别让它触发全局「跳登录页」事件
    session.me = await api<Me>('/me', { silent401: true });
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

// 任何请求收到 401 都清掉内存里的会话。
// 只有「本来登录着、突然 401」才算会话过期（需要把人送去登录页）；
// 游客本来就是未登录状态，401 是正常的，不能因此把人踢走。
if (typeof window !== 'undefined') {
  window.addEventListener('hive:unauthorized', () => {
    const wasLoggedIn = session.me !== null;
    session.me = null;
    if (wasLoggedIn) {
      window.dispatchEvent(new CustomEvent('hive:session-expired'));
    }
  });
}
