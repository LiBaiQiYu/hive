<script setup lang="ts">
/**
 * 段位徽章：勋章名 + 金星，没有数据时显示「未采集」。
 * 排行榜、战绩、后台成员三张表共用——同一个人的段位不该有三种画法。
 */
import { computed } from 'vue';
import { rankParts } from '../lib/rank';

const props = defineProps<{ rankTier: number | null }>();

const badge = computed(() => rankParts(props.rankTier));
</script>

<template>
  <span v-if="badge" class="lb-rank">
    <span class="lb-medal">{{ badge.name }}</span>
    <span v-if="badge.star > 0" class="lb-stars">
      <i v-for="n in badge.star" :key="n">★</i>
    </span>
  </span>
  <span v-else class="lb-none">未采集</span>
</template>
