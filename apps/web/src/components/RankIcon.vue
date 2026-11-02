<script setup lang="ts">
/**
 * 段位图标：勋章在下、星星在上，两张透明 PNG 同尺寸叠加。
 *
 * 素材本身就是按这个方式做的（星星画在 256×256 画布的顶部），所以这里不做定位计算，
 * 只负责"同一尺寸、同一起点、星在上"——换尺寸时两层会一起缩放，不会错位。
 */
import { computed } from 'vue';
import { MEDAL_ICONS, STAR_ICONS } from '../lib/rank-assets';
import { rankLabel, rankParts } from '../lib/rank';

const props = withDefaults(
  defineProps<{
    rankTier: number | null;
    /** 图标的边长（px）；奖章本身在画布里带透明边，视觉尺寸会略小一点 */
    size?: number;
  }>(),
  { size: 28 },
);

const parts = computed(() => rankParts(props.rankTier));
const label = computed(() => rankLabel(props.rankTier));
</script>

<template>
  <span
    v-if="parts"
    class="rank-icon"
    :style="{ width: `${size}px`, height: `${size}px` }"
    :title="label"
    role="img"
    :aria-label="label"
  >
    <img class="rank-icon-medal" :src="MEDAL_ICONS[parts.medal]" alt="" draggable="false" />
    <img
      v-if="parts.star > 0"
      class="rank-icon-star"
      :src="STAR_ICONS[parts.star]"
      alt=""
      draggable="false"
    />
  </span>
</template>
