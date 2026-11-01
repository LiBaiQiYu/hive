<script setup lang="ts">
import { computed } from 'vue';
import logoOnDark from '../assets/brand/hive-logo-on-dark.png';
import logoOnLight from '../assets/brand/hive-logo-on-light.png';
import { theme } from '../lib/theme';

const props = withDefaults(defineProps<{ height?: number }>(), { height: 32 });

/** 深色主题用浅色字标版本，浅色主题保留原始深蓝字标 —— 两份图的橙红徽章完全一致 */
const src = computed(() => (theme.value === 'dark' ? logoOnDark : logoOnLight));
/** 原图 218×77，按高度推宽度，避免图片加载前撑高顶栏 */
const width = computed(() => Math.round((props.height * 218) / 77));
</script>

<template>
  <img
    class="brand-logo"
    :src="src"
    :style="{ width: `${width}px`, height: `${props.height}px` }"
    :width="width"
    :height="props.height"
    alt="HIVE"
    decoding="async"
    draggable="false"
  />
</template>
