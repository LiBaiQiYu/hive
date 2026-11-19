<script setup lang="ts">
withDefaults(
  defineProps<{
    rows?: number;
    variant?: 'rows' | 'cards';
  }>(),
  {
    rows: 4,
    variant: 'rows',
  },
);
</script>

<template>
  <div
    class="skeleton"
    :class="`skeleton--${variant}`"
    role="status"
    aria-busy="true"
    aria-label="加载中"
  >
    <div v-for="n in rows" :key="n" class="skeleton-item">
      <span class="skeleton-bar skeleton-bar--title" />
      <span class="skeleton-bar" />
      <span class="skeleton-bar skeleton-bar--short" />
    </div>
  </div>
</template>
