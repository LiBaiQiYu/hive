<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { NButton, NSelect } from 'naive-ui';
import { ApiError, api, formatDate } from '../lib/api';

interface AuditEntry {
  id: string;
  actorId: string | null;
  actorRole: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  beforeJson: string | null;
  afterJson: string | null;
  reason: string | null;
  requestId: string | null;
  createdAt: number;
  actorName: string | null;
}

interface Facet {
  kind: string;
  value: string;
  count: number;
}

const entries = ref<AuditEntry[]>([]);
const actions = ref<Facet[]>([]);
const entityTypes = ref<Facet[]>([]);
const action = ref<string | null>(null);
const entityType = ref<string | null>(null);
const loading = ref(true);
const error = ref('');
const expanded = ref<string | null>(null);

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const params = new URLSearchParams();
    if (action.value) params.set('action', action.value);
    if (entityType.value) params.set('entityType', entityType.value);
    params.set('limit', '80');

    const data = await api<{ entries: AuditEntry[]; actions: Facet[]; entityTypes: Facet[] }>(
      `/admin/audit-logs?${params.toString()}`,
    );
    entries.value = data.entries;
    actions.value = data.actions;
    entityTypes.value = data.entityTypes;
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '加载失败';
  } finally {
    loading.value = false;
  }
}

onMounted(load);

const actionOptions = () =>
  actions.value.map((facet) => ({ label: `${facet.value}（${facet.count}）`, value: facet.value }));
const entityOptions = () =>
  entityTypes.value.map((facet) => ({ label: `${facet.value}（${facet.count}）`, value: facet.value }));

function pretty(json: string | null): string {
  if (!json) return '—';
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}

const toggle = (id: string) => {
  expanded.value = expanded.value === id ? null : id;
};
</script>

<template>
  <div class="container">
    <div class="section-head">
      <RouterLink to="/admin" class="muted" style="font-size: 13px">← 返回后台</RouterLink>
    </div>

    <div class="section-head">
      <h1 class="section-title">审计日志</h1>
      <NButton :disabled="loading" @click="load">刷新</NButton>
    </div>

    <p class="muted" style="font-size: 12px; margin: 0 0 14px">
      所有管理员操作都落在这张表里（评分修正、赛事流转、角色变更、阵容调整…），只读、不可删。
    </p>

    <div style="display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 14px">
      <NSelect
        v-model:value="action"
        :options="actionOptions()"
        placeholder="全部动作"
        clearable
        style="width: 220px"
        @update:value="load"
      />
      <NSelect
        v-model:value="entityType"
        :options="entityOptions()"
        placeholder="全部对象"
        clearable
        style="width: 180px"
        @update:value="load"
      />
    </div>

    <p v-if="error" class="alert">{{ error }}</p>

    <div v-if="loading" class="empty">加载中…</div>

    <div v-else-if="entries.length === 0" class="empty">没有匹配的记录。</div>

    <div v-else class="card" style="padding: 8px 12px">
      <table class="table">
        <thead>
          <tr>
            <th>时间</th>
            <th>操作人</th>
            <th>动作</th>
            <th>对象</th>
            <th>说明</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <template v-for="entry in entries" :key="entry.id">
            <tr style="cursor: pointer" @click="toggle(entry.id)">
              <td class="muted" style="font-size: 12px">{{ formatDate(entry.createdAt) }}</td>
              <td>
                {{ entry.actorName ?? '—' }}
                <span class="muted" style="font-size: 11px">{{ entry.actorRole ?? '' }}</span>
              </td>
              <td class="mono" style="font-size: 12px">{{ entry.action }}</td>
              <td class="mono muted" style="font-size: 11px">
                {{ entry.entityType }}{{ entry.entityId ? `:${entry.entityId.slice(0, 8)}` : '' }}
              </td>
              <td class="muted" style="font-size: 12px; max-width: 280px">{{ entry.reason ?? '—' }}</td>
              <td class="muted" style="text-align: right; font-size: 12px">
                {{ expanded === entry.id ? '收起' : '详情' }}
              </td>
            </tr>
            <tr v-if="expanded === entry.id">
              <td colspan="6">
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; padding: 8px 0">
                  <div>
                    <div class="stat-label" style="margin-bottom: 4px">改前</div>
                    <pre class="audit-json">{{ pretty(entry.beforeJson) }}</pre>
                  </div>
                  <div>
                    <div class="stat-label" style="margin-bottom: 4px">改后</div>
                    <pre class="audit-json">{{ pretty(entry.afterJson) }}</pre>
                  </div>
                </div>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>
  </div>
</template>
