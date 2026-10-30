<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
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

    <div class="nav-links" style="margin-bottom: 20px; flex-wrap: wrap">
      <button
        v-for="item in FILTERS"
        :key="item.key"
        type="button"
        class="nav-link"
        :class="{ active: filter === item.key }"
        style="border: none; background: none; cursor: pointer"
        @click="filter = item.key"
      >
        {{ item.label }}
      </button>
    </div>

    <div v-if="loading" class="empty">加载中…</div>
    <div v-else-if="visible.length === 0" class="empty">这个分组下还没有赛事。</div>
    <div v-else class="grid grid-3">
      <EventCard v-for="event in visible" :key="event.id" :event="event" />
    </div>
  </div>
</template>
