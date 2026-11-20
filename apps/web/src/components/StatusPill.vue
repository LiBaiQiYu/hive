<script setup lang="ts">
import { computed } from 'vue';
import { MATCH_STATUS_LABEL, STATUS_LABEL } from '../lib/api';

const props = withDefaults(defineProps<{ status: string; kind?: 'event' | 'match' }>(), {
  kind: 'event',
});

const label = computed(
  () => (props.kind === 'match' ? MATCH_STATUS_LABEL : STATUS_LABEL)[props.status] ?? props.status,
);

const tone = computed(() => {
  if (props.kind === 'match') {
    if (props.status === 'PUBLISHED') return 'published';
    if (props.status === 'IN_PROGRESS') return 'open';
    return 'idle';
  }
  if (props.status === 'REGISTRATION_OPEN') return 'open';
  if (props.status === 'REGISTRATION_CLOSED') return 'closed';
  if (props.status === 'PUBLISHED') return 'published';
  return 'idle';
});
</script>

<template>
  <span class="pill" :class="`pill-${tone}`">{{ label }}</span>
</template>
