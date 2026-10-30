<script setup lang="ts">
import { RouterLink } from 'vue-router';
import { formatDate, STATUS_LABEL, type EventView } from '../lib/api';

const props = defineProps<{ event: EventView }>();

const pillClass = (status: string) => {
  if (status === 'REGISTRATION_OPEN') return 'pill pill-open';
  if (status === 'REGISTRATION_CLOSED') return 'pill pill-closed';
  if (status === 'PUBLISHED') return 'pill pill-published';
  return 'pill pill-idle';
};
</script>

<template>
  <article class="card event-card">
    <div class="event-head">
      <h3 class="event-name">{{ props.event.title }}</h3>
      <span :class="pillClass(props.event.status)">
        {{ STATUS_LABEL[props.event.status] ?? props.event.status }}
      </span>
    </div>

    <div class="event-meta">
      <span>5v5 · DOTA2 · {{ props.event.capacity }} 人（{{ props.event.targetMatches }} 场）</span>
      <span v-if="props.event.registrationClosesAt">
        报名截止 {{ formatDate(props.event.registrationClosesAt) }}
      </span>
    </div>

    <div class="progress">
      <div
        class="progress-bar"
        :style="{ width: `${Math.min(100, (props.event.confirmed / props.event.capacity) * 100)}%` }"
      />
    </div>

    <div class="event-foot">
      <div>
        <span class="slots">{{ props.event.confirmed }} / {{ props.event.capacity }}</span>
        <span v-if="props.event.slotsToNextMatch !== null" class="muted" style="margin-left: 10px">
          再需 {{ props.event.slotsToNextMatch }} 人开下一场
        </span>
        <span v-else class="muted" style="margin-left: 10px">已满员</span>
      </div>
      <RouterLink :to="`/events/${props.event.id}`" class="btn">查看详情</RouterLink>
    </div>
  </article>
</template>
