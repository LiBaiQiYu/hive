<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { NButton, useMessage } from 'naive-ui';
import PageBack from '../components/PageBack.vue';
import { ApiError, api, formatDate } from '../lib/api';

interface JobRow {
  id: string;
  kind: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  availableAt: number;
  lastError: string | null;
  createdAt: number;
  finishedAt: number | null;
}

interface Summary {
  PENDING: number;
  RUNNING: number;
  DONE: number;
  FAILED: number;
  DEAD: number;
}

const jobs = ref<JobRow[]>([]);
const summary = ref<Summary | null>(null);
const byKind = ref<Array<{ kind: string; status: string; count: number }>>([]);
const loading = ref(true);
const busy = ref(false);
const error = ref('');
const toast = useMessage();

const alertCount = computed(() => (summary.value?.DEAD ?? 0) + (summary.value?.FAILED ?? 0));

async function refresh() {
  loading.value = true;
  error.value = '';
  try {
    const data = await api<{ summary: Summary; byKind: typeof byKind.value; jobs: JobRow[] }>(
      '/admin/jobs',
    );
    summary.value = data.summary;
    byKind.value = data.byKind;
    jobs.value = data.jobs;
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '加载失败';
  } finally {
    loading.value = false;
  }
}

onMounted(refresh);

async function retry(job: JobRow) {
  busy.value = true;
  try {
    await api(`/admin/jobs/${job.id}/retry`, { method: 'POST', body: {} });
    toast.success('已重新入队');
    await refresh();
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '重试失败';
    toast.error(error.value);
  } finally {
    busy.value = false;
  }
}

const statusTag = (status: string) => {
  if (status === 'DONE') return 'tag tag-confirmed';
  if (status === 'DEAD') return 'tag tag-waitlist';
  if (status === 'RUNNING') return 'tag tag-other';
  return 'tag tag-other';
};
</script>

<template>
  <div class="container">
    <PageBack label="返回后台" />

    <div class="section-head">
      <h1 class="section-title">队列健康</h1>
      <NButton :disabled="busy" @click="refresh">刷新</NButton>
    </div>

    <p class="muted" style="font-size: 12px; margin: 0 0 14px">
      D1 outbox：Cron 每分钟抽一次。判死（DEAD）的任务可以手动重试，重试后 attempts 归零。
    </p>

    <p v-if="error" class="alert">{{ error }}</p>

    <div v-if="loading" class="empty">加载中…</div>

    <template v-else>
      <section class="admin-stats">
        <div class="admin-stat">
          <div class="stat-label">待执行</div>
          <div class="admin-stat-value mono">{{ summary?.PENDING ?? 0 }}</div>
        </div>
        <div class="admin-stat">
          <div class="stat-label">执行中</div>
          <div class="admin-stat-value mono">{{ summary?.RUNNING ?? 0 }}</div>
        </div>
        <div class="admin-stat">
          <div class="stat-label">已完成</div>
          <div class="admin-stat-value mono">{{ summary?.DONE ?? 0 }}</div>
        </div>
        <div class="admin-stat" :class="{ 'admin-stat-warn': alertCount > 0 }">
          <div class="stat-label">异常</div>
          <div class="admin-stat-value mono">{{ alertCount }}</div>
          <div class="muted" style="font-size: 11px">
            失败 {{ summary?.FAILED ?? 0 }} · 判死 {{ summary?.DEAD ?? 0 }}
          </div>
        </div>
      </section>

      <section v-if="byKind.length > 0" class="section">
        <h2 class="section-title" style="margin-bottom: 10px">按类型</h2>
        <div class="muted" style="font-size: 12px; display: flex; gap: 16px; flex-wrap: wrap">
          <span v-for="row in byKind" :key="`${row.kind}-${row.status}`">
            {{ row.kind }} · {{ row.status }}: <b class="mono">{{ row.count }}</b>
          </span>
        </div>
      </section>

      <section class="section">
        <h2 class="section-title" style="margin-bottom: 10px">最近任务</h2>
        <div v-if="jobs.length === 0" class="empty">队列是空的。</div>
        <div v-else class="card" style="padding: 8px 12px">
          <table class="table">
            <thead>
              <tr>
                <th>类型</th>
                <th>状态</th>
                <th class="num">尝试</th>
                <th>创建</th>
                <th>错误</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="job in jobs" :key="job.id">
                <td class="mono" style="font-size: 12px">{{ job.kind }}</td>
                <td><span :class="statusTag(job.status)">{{ job.status }}</span></td>
                <td class="num mono">{{ job.attempts }} / {{ job.maxAttempts }}</td>
                <td class="muted" style="font-size: 12px">{{ formatDate(job.createdAt) }}</td>
                <td class="muted" style="font-size: 12px; max-width: 320px">
                  {{ job.lastError ?? '—' }}
                </td>
                <td style="text-align: right">
                  <NButton
                    v-if="job.status === 'DEAD' || job.status === 'FAILED'"
                    size="small"
                    :disabled="busy"
                    @click="retry(job)"
                  >
                    重试
                  </NButton>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>
  </div>
</template>
