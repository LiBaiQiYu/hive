<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import { ApiError, api, formatDate, STATUS_LABEL, type EventView } from '../lib/api';

const router = useRouter();
const events = ref<EventView[]>([]);
const loading = ref(true);
const creating = ref(false);
const error = ref('');

const form = ref({
  title: '',
  capacity: 20,
  closesAt: '',
  startsAt: '',
});

onMounted(async () => {
  await refresh();
});

async function refresh() {
  loading.value = true;
  try {
    events.value = await api<EventView[]>('/events');
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '加载失败';
  } finally {
    loading.value = false;
  }
}

/** datetime-local 给的是本地时间字符串，统一转成带时区的 ISO */
function toIso(local: string): string | undefined {
  if (!local) return undefined;
  const date = new Date(local);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

async function create() {
  creating.value = true;
  error.value = '';
  try {
    const created = await api<EventView>('/admin/events', {
      method: 'POST',
      body: {
        title: form.value.title,
        capacity: form.value.capacity,
        registrationClosesAt: toIso(form.value.closesAt),
        startsAt: toIso(form.value.startsAt),
      },
    });
    form.value = { title: '', capacity: 20, closesAt: '', startsAt: '' };
    void router.push(`/admin/events/${created.id}`);
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '创建失败';
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <div class="container">
    <div class="section-head">
      <h1 class="section-title">管理后台</h1>
      <div style="display: flex; gap: 10px; align-items: center">
        <RouterLink to="/admin/ratings" class="btn btn-ghost">评分管理</RouterLink>
        <RouterLink to="/admin/invites" class="btn btn-ghost">邀请码管理</RouterLink>
        <span class="muted" style="font-size: 13px">赛事组织</span>
      </div>
    </div>

    <p v-if="error" class="alert">{{ error }}</p>

    <section class="card">
      <h2 class="card-title">新建赛事</h2>
      <form class="admin-form" @submit.prevent="create">
        <label class="field" style="margin: 0">
          <span class="field-label">赛事名称</span>
          <input v-model="form.title" class="input" placeholder="HIVE 第 01 期周末内战" required />
        </label>
        <label class="field" style="margin: 0">
          <span class="field-label">目标人数（10 的倍数）</span>
          <select v-model.number="form.capacity" class="input">
            <option :value="10">10 人 · 1 场</option>
            <option :value="20">20 人 · 2 场</option>
            <option :value="30">30 人 · 3 场</option>
          </select>
        </label>
        <label class="field" style="margin: 0">
          <span class="field-label">报名截止</span>
          <input v-model="form.closesAt" class="input" type="datetime-local" />
        </label>
        <label class="field" style="margin: 0">
          <span class="field-label">开赛时间</span>
          <input v-model="form.startsAt" class="input" type="datetime-local" />
        </label>
        <button class="btn btn-primary" type="submit" :disabled="creating">
          {{ creating ? '创建中…' : '创建' }}
        </button>
      </form>
    </section>

    <section class="section">
      <div class="section-head">
        <h2 class="section-title">全部赛事</h2>
        <button class="btn btn-ghost" type="button" @click="refresh">刷新</button>
      </div>

      <div v-if="loading" class="empty">加载中…</div>
      <div v-else-if="events.length === 0" class="empty">还没有赛事，先在上面创建一个。</div>

      <div v-else class="card" style="padding: 8px 12px">
        <table class="table">
          <thead>
            <tr>
              <th>赛事</th>
              <th>状态</th>
              <th class="num">报名</th>
              <th>报名截止</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="event in events" :key="event.id">
              <td>{{ event.title }}</td>
              <td>
                <span class="pill pill-idle">{{ STATUS_LABEL[event.status] ?? event.status }}</span>
              </td>
              <td class="num">{{ event.confirmed }} / {{ event.capacity }}</td>
              <td class="muted">{{ formatDate(event.registrationClosesAt) }}</td>
              <td style="text-align: right">
                <RouterLink :to="`/admin/events/${event.id}`" class="btn btn-ghost">管理</RouterLink>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>
