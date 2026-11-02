<script setup lang="ts">
/**
 * 二级页左上角的「返回」。
 *
 * 以前每页各写一份：后台五个子页是纯文字「← 返回后台」，评分管理是带图标的胶囊，
 * 账号设置是右侧的圆角 chip——三套样式、两种位置。统一收在这里：
 * 一律放在标题上方、内容左侧，样式复用 .back-link（见 styles-ui.css）。
 *
 * 文案约定「返回 + 目的地」，比如「返回后台」「返回我的主页」，别只写「返回」。
 */
import { RouterLink } from 'vue-router';

withDefaults(
  defineProps<{
    /** 返回目标 */
    to?: string;
    /** 按钮文字 */
    label?: string;
  }>(),
  { to: '/admin', label: '返回' },
);
</script>

<template>
  <div class="page-back">
    <RouterLink :to="to" class="back-link">
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
      <span class="back-label">{{ label }}</span>
    </RouterLink>
  </div>
</template>
