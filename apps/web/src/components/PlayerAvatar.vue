<script setup lang="ts">
/**
 * 圆形玩家头像（Steam / STRATZ 抓来的公开图）。
 *
 * 抽出来是因为列表里一行一个图：加载失败必须**逐行**记住，不能靠一个全局变量，
 * 也不能用 `onerror="..."` 内联处理器——CSP 的 `script-src 'self'` 会把内联处理器一起拦掉。
 * 没有地址或加载失败时整块不渲染，调用方的文字自然左对齐，不会留一个破图框
 * （与玩家卡 `.pcard-avatar` 的处理保持一致；卡上有 3D 位移，所以那边没复用这个组件）。
 */
import { ref, watch } from 'vue';

const props = withDefaults(
  defineProps<{
    src?: string | null;
    /** 边长（px） */
    size?: number;
  }>(),
  { src: null, size: 26 },
);

const broken = ref(false);

/** 换人、换头像时允许重新尝试 */
watch(
  () => props.src,
  () => {
    broken.value = false;
  },
);
</script>

<template>
  <img
    v-if="src && !broken"
    class="player-avatar"
    :src="src"
    :width="size"
    :height="size"
    alt=""
    loading="lazy"
    referrerpolicy="no-referrer"
    draggable="false"
    @error="broken = true"
  />
</template>
