<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { ApiError, api } from '../lib/api';

interface RatingRow {
  id: string;
  username: string;
  displayName: string;
  role: string;
  system: number | null;
  adjustment: number | null;
  effective: number | null;
  confidenceBp: number | null;
  rankTier: number | null;
  declaredMmr: number | null;
  limit: number;
}

interface HistoryRow {
  id: string;
  oldAdjustment: number;
  newAdjustment: number;
  newEffective: number;
  reason: string;
  createdAt: number;
  operatorName: string | null;
}

const players = ref<RatingRow[]>([]);
const loading = ref(true);
const busy = ref(false);
const error = ref('');
const message = ref('');

const editing = ref<string | null>(null);
const form = ref({ adjustment: 0, reason: '' });
const history = ref<HistoryRow[]>([]);
const historyFor = ref<string | null>(null);

async function refresh() {
  loading.value = true;
  try {
    const data = await api<{ players: RatingRow[] }>('/admin/ratings/players');
    players.value = data.players;
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '加载失败';
  } finally {
    loading.value = false;
  }
}

onMounted(refresh);

function openEdit(player: RatingRow) {
  editing.value = player.id;
  form.value = { adjustment: player.adjustment ?? 0, reason: '' };
  error.value = '';
  message.value = '';
}

async function save(player: RatingRow) {
  if (form.value.reason.trim().length < 4) {
    error.value = '修正原因至少 4 个字';
    return;
  }
  busy.value = true;
  error.value = '';
  try {
    const result = await api<{ effective: number }>(
      `/admin/ratings/players/${player.id}/rating-adjustment`,
      { method: 'PUT', body: { adjustment: form.value.adjustment, reason: form.value.reason } },
    );
    message.value = `${player.displayName} 已更新为 ${result.effective}`;
    editing.value = null;
    await refresh();
    if (historyFor.value === player.id) await loadHistory(player.id);
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '保存失败';
  } finally {
    busy.value = false;
  }
}

async function loadHistory(userId: string) {
  try {
    const data = await api<{ history: HistoryRow[] }>(`/admin/ratings/players/${userId}/history`);
    history.value = data.history;
    historyFor.value = userId;
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '加载历史失败';
  }
}

async function recompute() {
  busy.value = true;
  error.value = '';
  try {
    const data = await api<{ updated: number }>('/admin/ratings/recompute', { method: 'POST', body: {} });
    message.value = `已重算 ${data.updated} 名玩家（管理员修正保持不变）`;
    await refresh();
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '重算失败';
  } finally {
    busy.value = false;
  }
}

const fmt = (ts: number) => new Date(ts).toLocaleString('zh-CN', { hour12: false });
const signed = (n: number | null) => (n === null ? '—' : `${n >= 0 ? '+' : ''}${n}`);
</script>

<template>
  <div class="container">
    <div class="section-head">
      <RouterLink to="/admin" class="muted" style="font-size: 13px">← 返回后台</RouterLink>
    </div>

    <div class="section-head">
      <h1 class="section-title">评分管理</h1>
      <div style="display: flex; gap: 10px">
        <button class="btn btn-ghost" type="button" :disabled="busy" @click="refresh">刷新</button>
        <button class="btn" type="button" :disabled="busy" @click="recompute">重算全部</button>
      </div>
    </div>

    <p class="muted" style="font-size: 12px; margin: 0 0 14px">
      重算只更新系统分，不会改动你手工设置的修正；修正上限随数据置信度自动放宽（150 → 500）。
    </p>

    <p v-if="error" class="alert">{{ error }}</p>
    <p v-if="message" class="muted" style="margin: 0 0 14px">{{ message }}</p>

    <div v-if="loading" class="empty">加载中…</div>

    <div v-else class="card" style="padding: 8px 12px">
      <table class="table">
        <thead>
          <tr>
            <th>玩家</th>
            <th class="num">系统分</th>
            <th class="num">修正</th>
            <th class="num">最终</th>
            <th class="num">置信度</th>
            <th class="num">可修正</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <template v-for="player in players" :key="player.id">
            <tr>
              <td>
                {{ player.displayName }}
                <span class="muted" style="font-size: 12px">@{{ player.username }}</span>
                <span v-if="player.role === 'ADMIN'" class="tag tag-other" style="margin-left: 6px">管理员</span>
              </td>
              <td class="num mono">{{ player.system ?? '—' }}</td>
              <td class="num mono">{{ signed(player.adjustment) }}</td>
              <td class="num mono" style="color: var(--gold-2)">{{ player.effective ?? '—' }}</td>
              <td class="num mono">{{ ((player.confidenceBp ?? 0) / 100).toFixed(0) }}%</td>
              <td class="num mono muted">±{{ player.limit }}</td>
              <td style="text-align: right">
                <button class="btn btn-ghost" type="button" @click="openEdit(player)">调整</button>
                <button class="btn btn-ghost" type="button" @click="loadHistory(player.id)">历史</button>
              </td>
            </tr>

            <tr v-if="editing === player.id">
              <td colspan="7">
                <div style="display: flex; gap: 10px; align-items: center; flex-wrap: wrap; padding: 6px 0">
                  <input
                    v-model.number="form.adjustment"
                    class="input mono"
                    type="number"
                    :min="-player.limit"
                    :max="player.limit"
                    style="width: 110px"
                  />
                  <input
                    v-model="form.reason"
                    class="input"
                    placeholder="修正原因（必填，至少 4 个字）"
                    maxlength="200"
                    style="flex: 1; min-width: 240px"
                  />
                  <button class="btn btn-primary" type="button" :disabled="busy" @click="save(player)">
                    保存
                  </button>
                  <button class="btn btn-ghost" type="button" @click="editing = null">取消</button>
                </div>
              </td>
            </tr>

            <tr v-if="historyFor === player.id">
              <td colspan="7">
                <div v-if="history.length === 0" class="muted" style="font-size: 12px; padding: 6px 0">
                  还没有修正记录。
                </div>
                <table v-else class="table" style="margin: 6px 0">
                  <thead>
                    <tr>
                      <th>时间</th>
                      <th class="num">修正</th>
                      <th class="num">最终分</th>
                      <th>原因</th>
                      <th>操作人</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="item in history" :key="item.id">
                      <td class="muted">{{ fmt(item.createdAt) }}</td>
                      <td class="num mono">{{ signed(item.oldAdjustment) }} → {{ signed(item.newAdjustment) }}</td>
                      <td class="num mono">{{ item.newEffective }}</td>
                      <td>{{ item.reason }}</td>
                      <td class="muted">{{ item.operatorName ?? '—' }}</td>
                    </tr>
                  </tbody>
                </table>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>
  </div>
</template>
