<script setup lang="ts">
/**
 * 二级页左上角的「返回」。
 *
 * 以前每页各写一份：后台五个子页是纯文字「← 返回后台」，评分管理是带图标的胶囊，
 * 账号设置是右侧的圆角 chip——三套样式、两种位置。统一收在这里：
 * 一律放在标题上方、内容左侧，样式复用 .back-link（见 styles-ui.css）。
 *
 * 两种返回语义：
 *   1. 默认（`to` + `label`）：上级页固定。后台子页 → 后台、账号设置 → 我的主页、
 *      赛事详情 → 赛事列表，这些页只有一个"父亲"，写死更可预测。
 *   2. `back`：先回浏览器历史里的上一页，只有站外进来（没有任何站内来源）才回落到 `to`。
 *      玩家详情页这种「可以从任何卡片/评论入口进来」的页面必须用这个——
 *      否则从赛事报名名单点进去，返回却把人送去排行榜。
 *
 * 文案仍然遵守「返回 + 目的地」，目的地未知时才写「返回上一页」。
 */
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { backLabel, readBackPath } from '../lib/back';

const props = withDefaults(
  defineProps<{
    /** 固定返回目标；`back` 模式下作为没有站内来源时的兜底 */
    to?: string;
    /** 按钮文字；`back` 模式下只在兜底时使用 */
    label?: string;
    /** 优先返回上一页（历史栈），而不是固定目标 */
    back?: boolean;
  }>(),
  { to: '/admin', label: '返回', back: false },
);

const router = useRouter();
const route = useRoute();

/**
 * 用 watch(route.fullPath) 而不是 onMounted：/players/a → /players/b 会复用同一个
 * 组件实例，只认挂载那一刻的值会拿到过期的来源路径。
 */
const backPath = ref<string | null>(readBackPath(window.history.state));
watch(
  () => route.fullPath,
  () => {
    backPath.value = readBackPath(window.history.state);
  },
  { immediate: true },
);

const canGoBack = computed(() => Boolean(props.back && backPath.value));
const target = computed(() => (canGoBack.value ? (backPath.value as string) : props.to));
const text = computed(() => (canGoBack.value ? backLabel(backPath.value) : props.label));

/**
 * 带修饰键/非左键的点击放给浏览器（Ctrl+点击开新标签页、右键另存等照常可用）；
 * 普通点击才拦下来走路由，SPA 的滚动恢复才不会丢。
 */
function onClick(event: MouseEvent) {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return;
  }
  event.preventDefault();
  if (canGoBack.value) router.back();
  else void router.push(props.to);
}
</script>

<template>
  <div class="page-back">
    <a :href="target" class="back-link" @click="onClick">
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M9.8 3.2 5 8l4.8 4.8"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
      <span class="back-label">{{ text }}</span>
    </a>
  </div>
</template>
