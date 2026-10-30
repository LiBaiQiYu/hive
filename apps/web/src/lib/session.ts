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
