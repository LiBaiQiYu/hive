<script setup lang="ts">
/**
 * 段位 / MMR 单元格：勋章 + 星级在上，天梯分在下。
 *
 * 排行榜和战绩页共用——同一个人在两页显示成两种样子（一页有星、一页没有）
 * 是最容易被截图吐槽的那类不一致。样式见 styles-me.css 的 .lb-*。
 */
import { computed } from 'vue';
import { rankParts } from '../lib/rank';

const props = defineProps<{
  /** rank_tier 编码；null = 没同步过 */
  rankTier: number | null;
  /** 天梯分：只有「自报」路线才有 */
  declaredMmr: number | null;
  rankSource?: string | null;
}>();

const badge = computed(() => rankParts(props.rankTier));

const mmrText = computed(() =>
  props.declaredMmr === null ? '—' : props.declaredMmr.toLocaleString('en-US'),
);

/**
 * 为什么有人有段位却没 MMR：Steam / OpenDota / STRATZ 同步只给勋章，不给天梯分；
 * 只有「自己填」这条路会带 MMR。悬停说明一下，别让人以为是数据丢了。
 */
const mmrHint = computed(() => {
  if (props.declaredMmr !== null) {
    return props.rankSource === 'SELF_REPORTED' ? '自己填写的天梯分' : '账号同步来的天梯分';
  }
  if (props.rankTier !== null) {
    return '段位来自 Steam / OpenDota / STRATZ 同步，这类数据不含天梯分';
  }
  return '还没有段位数据：绑定 Steam，或在「我的主页 → 游戏身份」里手动填写';
});
</script>

<template>
  <div class="lb-rank">
    <template v-if="badge">
      <span class="lb-medal">{{ badge.name }}</span>
      <span v-if="badge.star > 0" class="lb-stars">
        <i v-for="n in badge.star" :key="n">★</i>
      </span>
    </template>
    <span v-else class="lb-none">未采集</span>
  </div>
  <div class="lb-mmr mono" :title="mmrHint">{{ mmrText }}</div>
</template>
