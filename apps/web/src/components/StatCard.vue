<script setup lang="ts">
import { RouterLink } from 'vue-router';

withDefaults(
  defineProps<{
    label: string;
    value: string | number;
    tone?: 'default' | 'warn';
    to?: string;
  }>(),
  {
    tone: 'default',
    to: undefined,
  },
);
</script>

<template>
  <component
    :is="to ? RouterLink : 'div'"
    :to="to"
    class="stat"
    :class="{ 'stat-warn': tone === 'warn', 'stat-link': !!to }"
  >
    <div class="stat-label">{{ label }}</div>
    <div class="stat-value">{{ value }}</div>
    <div v-if="$slots.default" class="stat-hint"><slot /></div>
  </component>
</template>
