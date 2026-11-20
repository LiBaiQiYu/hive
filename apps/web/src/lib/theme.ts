import { ref } from 'vue';

export type Theme = 'dark' | 'light';

const KEY = 'hive-theme';

export const theme = ref<Theme>('dark');

function apply(next: Theme): void {
  theme.value = next;
  document.documentElement.dataset.theme = next;
}

/** 初次加载：显式选择 > 系统偏好 > 深色 */
export function initTheme(): void {
  const saved = localStorage.getItem(KEY);
  if (saved === 'light' || saved === 'dark') {
    apply(saved);
    return;
  }
  const prefersLight =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: light)').matches;
  apply(prefersLight ? 'light' : 'dark');
}

export function toggleTheme(): void {
  const next: Theme = theme.value === 'dark' ? 'light' : 'dark';
  apply(next);
  localStorage.setItem(KEY, next);
}
