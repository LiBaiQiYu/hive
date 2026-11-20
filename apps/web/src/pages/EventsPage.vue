<script setup lang="ts">
import SkeletonRows from '../components/SkeletonRows.vue';
import { computed, onMounted, ref } from 'vue';
import { NRadioButton, NRadioGroup } from 'naive-ui';
import EventCard from '../components/EventCard.vue';
import { api, STATUS_LABEL, type EventView } from '../lib/api';

const events = ref<EventView[]>([]);
const loading = ref(true);
const filter = ref<string>('ALL');

const FILTERS = [
  { key: 'ALL', label: '全部' },
  { key: 'REGISTRATION_OPEN', label: STATUS_LABEL.REGISTRATION_OPEN ?? '报名中' },
  { key: 'REGISTRATION_CLOSED', label: STATUS_LABEL.REGISTRATION_CLOSED ?? '报名截止' },
  { key: 'PUBLISHED', label: STATUS_LABEL.PUBLISHED ?? '阵容已发布' },
  { key: 'COMPLETED', label: STATUS_LABEL.COMPLETED ?? '已结束' },
  { key: 'CANCELLED', label: STATUS_LABEL.CANCELLED ?? '已取消' },
];

onMounted(async () => {
  try {
    events.value = await api<EventView[]>('/events');
  } catch {
    events.value = [];
  } finally {
    loading.value = false;
  }
});

const visible = computed(() =>
  filter.value === 'ALL' ? events.value : events.value.filter((e) => e.status === filter.value),
);
</script>

<template>
  <div class="container">
    <div class="section-head">
      <h1 class="section-title">赛事</h1>
      <span class="muted" style="font-size: 13px">共 {{ events.length }} 场</span>
    </div>

    <NRadioGroup v-model:value="filter" size="small" class="event-filters">
      <NRadioButton v-for="item in FILTERS" :key="item.key" :value="item.key">
        {{ item.label }}
      </NRadioButton>
    </NRadioGroup>

    <SkeletonRows v-if="loading" variant="cards" :rows="3" />
    <div v-else-if="visible.length === 0" class="empty">
      这个分组下还没有赛事。
      <button
        v-if="filter !== 'ALL'"
        type="button"
        class="empty-action"
        @click="filter = 'ALL'"
      >
        看全部赛事
      </button>
    </div>
    <div v-else class="grid grid-3">
      <EventCard v-for="event in visible" :key="event.id" :event="event" />
    </div>
  </div>
</template>
