<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    active?: boolean;
    direction?: 'asc' | 'desc';
    numeric?: boolean;
  }>(),
  {
    active: false,
    direction: 'desc',
    numeric: false,
  },
);

const emit = defineEmits<{ sort: [] }>();

const ariaSort = computed(() =>
  props.active ? (props.direction === 'asc' ? 'ascending' : 'descending') : 'none',
);
</script>

<template>
  <th
    :class="['th-sort', { num: numeric }]"
    :aria-sort="ariaSort"
    tabindex="0"
    @click="emit('sort')"
    @keydown.enter.prevent="emit('sort')"
    @keydown.space.prevent="emit('sort')"
  >
    <slot />
  </th>
</template>
