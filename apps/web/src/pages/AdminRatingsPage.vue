<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { NButton, NInput, NInputNumber, useMessage } from 'naive-ui';
import HelpTip from '../components/HelpTip.vue';
import PageBack from '../components/PageBack.vue';
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
  oldEffective: number;
  newEffective: number;
  reason: string;
  createdAt: number;
  operatorName: string | null;
}

const players = ref<RatingRow[]>([]);
const loading = ref(true);
const busy = ref(false);
const saving = ref<string | null>(null);
const error = ref('');
const message = ref('');

const editing = ref<string | null>(null);
const form = ref({ adjustment: 0, reason: '' });

const history = ref<HistoryRow[]>([]);
const historyFor = ref<string | null>(null);
const historyLoading = ref(false);

const toast = useMessage();

/** 顶部概览：玩家数、被人工修正过的人数、平均置信度 */
const stats = computed(() => {
  const list = players.value;
  const adjusted = list.filter((p) => (p.adjustment ?? 0) !== 0).length;
  const avg = list.length
    ? Math.round(list.reduce((sum, p) => sum + confidenceOf(p), 0) / list.length)
    : 0;
  return { adjusted, avg };
});

async function refresh(silent = false) {
  if (!silent) loading.value = true;
  try {
    const data = await api<{ players: RatingRow[] }>('/admin/ratings/players');
    players.value = data.players;
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '加载失败';
  } finally {
    loading.value = false;
  }
}

onMounted(() => refresh());

function openEdit(player: RatingRow) {
  if (editing.value === player.id) {
    editing.value = null;
    return;
  }
  historyFor.value = null;
  editing.value = player.id;
  form.value = { adjustment: player.adjustment ?? 0, reason: '' };
  error.value = '';
  message.value = '';
}

function cancelEdit() {
  editing.value = null;
  error.value = '';
}

async function save(player: RatingRow) {
  if (form.value.reason.trim().length < 4) {
    error.value = '修正原因至少 4 个字';
    return;
  }
  saving.value = player.id;
  error.value = '';
  try {
    const result = await api<{ effective: number }>(
      `/admin/ratings/players/${player.id}/rating-adjustment`,
      { method: 'PUT', body: { adjustment: form.value.adjustment, reason: form.value.reason } },
    );
    message.value = `${player.displayName} 的最终分已更新为 ${result.effective}`;
    toast.success(`已更新 ${player.displayName}：${result.effective} 分`);
    editing.value = null;
    await refresh(true);
    if (historyFor.value === player.id) await loadHistory(player.id);
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '保存失败';
  } finally {
    saving.value = null;
  }
}

async function loadHistory(userId: string) {
  historyLoading.value = true;
  try {
    const data = await api<{ history: HistoryRow[] }>(`/admin/ratings/players/${userId}/history`);
    // 用户可能在请求飞行途中又点了收起/别的玩家，别把结果写到错误的面板里
    if (historyFor.value === userId) history.value = data.history;
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '加载历史失败';
  } finally {
    historyLoading.value = false;
  }
}

/** 同一个玩家的"历史"按钮是开关键：再点一次收起 */
async function toggleHistory(player: RatingRow) {
  if (historyFor.value === player.id) {
    historyFor.value = null;
    return;
  }
  editing.value = null;
  historyFor.value = player.id;
  history.value = [];
  await loadHistory(player.id);
}

async function recompute() {
  busy.value = true;
  error.value = '';
  try {
    const data = await api<{ updated: number }>('/admin/ratings/recompute', {
      method: 'POST',
      body: {},
    });
    message.value = `已重算 ${data.updated} 名玩家（管理员修正保持不变）`;
    toast.success(`已重算 ${data.updated} 名玩家`);
    await refresh(true);
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '重算失败';
  } finally {
    busy.value = false;
  }
}

const fmt = (ts: number) => new Date(ts).toLocaleString('zh-CN', { hour12: false });
const signed = (n: number | null) => (n === null ? '—' : `${n >= 0 ? '+' : ''}${n}`);

/** 置信度是万分比（1000 = 10%） */
const confidenceOf = (player: RatingRow) => Math.round((player.confidenceBp ?? 0) / 100);

const MEDALS = ['先锋', '卫士', '中军', '统帅', '传奇', '万古流芳', '超凡入圣', '冠绝'];

/** rank_tier = 勋章 × 10 + 星级；冠绝（80）没有星 */
function rankLabel(rankTier: number | null): string {
  if (!rankTier) return '未填';
  const medal = Math.floor(rankTier / 10);
  const star = rankTier % 10;
  const name = MEDALS[medal - 1] ?? '未知';
  return medal === 8 ? name : `${name} ${star} 星`;
}

/** 调整预览：和 computeEffective 同一口径（clamp 0..1000） */
function previewEffective(player: RatingRow): number {
  const system = player.system ?? 0;
  return Math.min(1000, Math.max(0, Math.round(system + form.value.adjustment)));
}

function deltaClass(n: number | null): string {
  if (n === null || n === 0) return '';
  return n > 0 ? 'delta-pos' : 'delta-neg';
}
</script>

<template>
  <div class="container">
    <PageBack label="返回后台" />

    <header class="ratings-head">
      <div class="ratings-heading">
        <h1 class="section-title">
          评分管理
          <HelpTip
            wide
            title="重算和修正的关系"
            :steps="[
              '① 重算只更新系统分（段位 900 + 出勤 100），不动你手工设置的修正',
              '② 修正上限随数据置信度自动放宽：150 → 500',
              '③ 修正必须填原因，记录不可删除',
            ]"
            note="录入比赛结果、赛事转「已结束」都会触发重算；已公布的阵容与报名快照不受影响。"
          />
        </h1>
      </div>
      <div class="ratings-head-actions">
        <NButton :disabled="busy || loading" @click="refresh()">
          <template #icon>
            <svg class="btn-icon" viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M13.4 8a5.4 5.4 0 1 1-1.7-3.9"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
              />
              <path
                d="M13.4 2.6v3.1h-3"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </template>
          刷新
        </NButton>
        <NButton type="primary" :disabled="busy || loading" :loading="busy" @click="recompute">
          <template #icon>
            <svg class="btn-icon" viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M2.6 6.1A5.5 5.5 0 0 1 12.1 4.2"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
              />
              <path
                d="M13.4 9.9A5.5 5.5 0 0 1 3.9 11.8"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
              />
              <path
                d="M11.9 1.6v2.8H9.1M4.1 14.4v-2.8h2.8"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </template>
          重算全部
        </NButton>
      </div>
    </header>

    <p v-if="error" class="alert">{{ error }}</p>
    <p v-if="message" class="ratings-message">{{ message }}</p>

    <ul v-if="!loading" class="rating-stats">
      <li class="rating-stat">
        <span class="rating-stat-label">在册玩家</span>
        <span class="rating-stat-value">{{ players.length }}</span>
      </li>
      <li class="rating-stat">
        <span class="rating-stat-label">人工修正</span>
        <span class="rating-stat-value">{{ stats.adjusted }}</span>
      </li>
      <li class="rating-stat">
        <span class="rating-stat-label">平均置信度</span>
        <span class="rating-stat-value">{{ stats.avg }}<small>%</small></span>
      </li>
    </ul>

    <div v-if="loading" class="empty">加载中…</div>
    <div v-else-if="players.length === 0" class="empty">还没有玩家资料。</div>

    <section v-else class="card ratings-card">
      <div class="ratings-scroll">
        <table class="table ratings-table">
          <thead>
            <tr>
              <th>玩家</th>
              <th class="num">段位</th>
              <th class="num">系统分</th>
              <th class="num">修正</th>
              <th class="num">最终</th>
              <th class="num">置信度</th>
              <th class="num">可修正</th>
              <th class="col-actions">操作</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="player in players" :key="player.id">
              <tr class="rating-row" :class="{ 'is-open': editing === player.id || historyFor === player.id }">
                <td>
                  <div class="player-cell">
                    <span class="player-avatar" aria-hidden="true">
                      {{ player.displayName.slice(0, 1) }}
                    </span>
                    <span class="player-id">
                      <span class="player-name" :title="player.displayName">
                        {{ player.displayName }}
                      </span>
                      <span class="player-handle">
                        @{{ player.username }}
                        <span v-if="player.role === 'ADMIN'" class="tag tag-other">管理员</span>
                      </span>
                    </span>
                  </div>
                </td>
                <td class="num muted">{{ rankLabel(player.rankTier) }}</td>
                <td class="num mono">{{ player.system ?? '—' }}</td>
                <td class="num mono" :class="deltaClass(player.adjustment)">
                  {{ signed(player.adjustment) }}
                </td>
                <td class="num">
                  <span class="effective-score">{{ player.effective ?? '—' }}</span>
                </td>
                <td class="num">
                  <div class="confidence" :title="`置信度 ${confidenceOf(player)}%`">
                    <span class="confidence-track">
                      <span
                        class="confidence-fill"
                        :style="{ width: `${confidenceOf(player)}%` }"
                      />
                    </span>
                    <span class="confidence-text mono">{{ confidenceOf(player) }}%</span>
                  </div>
                </td>
                <td class="num mono muted">±{{ player.limit }}</td>
                <td class="col-actions">
                  <div class="row-actions">
                    <NButton
                      size="small"
                      class="rating-action"
                      :class="{ 'is-active': editing === player.id }"
                      :aria-expanded="editing === player.id"
                      @click="openEdit(player)"
                    >
                      <template #icon>
                        <svg class="btn-icon" viewBox="0 0 16 16" aria-hidden="true">
                          <path
                            d="M11.1 2.5 13.5 4.9 5.9 12.5l-3.2.8.8-3.2z"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="1.4"
                            stroke-linejoin="round"
                          />
                          <path
                            d="M9.7 3.9 12.1 6.3"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="1.4"
                          />
                        </svg>
                      </template>
                      调整
                    </NButton>
                    <NButton
                      size="small"
                      class="rating-action rating-action-history"
                      :class="{ 'is-active': historyFor === player.id }"
                      :aria-expanded="historyFor === player.id"
                      @click="toggleHistory(player)"
                    >
                      <template #icon>
                        <svg class="btn-icon" viewBox="0 0 16 16" aria-hidden="true">
                          <circle
                            cx="8"
                            cy="8"
                            r="5.5"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="1.4"
                          />
                          <path
                            d="M8 4.7V8l2.3 1.6"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="1.4"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                          />
                        </svg>
                      </template>
                      历史
                    </NButton>
                  </div>
                </td>
              </tr>

              <tr v-if="editing === player.id" class="panel-row">
                <td colspan="8">
                  <form class="adjust-panel" @submit.prevent="save(player)" @keydown.esc="cancelEdit">
                    <div class="adjust-head">
                      <span class="adjust-title">调整「{{ player.displayName }}」的修正</span>
                      <span class="adjust-hint">
                        可填 {{ -player.limit }} ～ +{{ player.limit }}，系统分
                        <span class="mono">{{ player.system ?? '—' }}</span>
                      </span>
                    </div>
                    <div class="adjust-body">
                      <label class="adjust-field">
                        <span class="field-label">修正值</span>
                        <NInputNumber
                          v-model:value="form.adjustment"
                          class="mono"
                          :min="-player.limit"
                          :max="player.limit"
                          :show-button="false"
                          style="width: 108px"
                        />
                      </label>
                      <label class="adjust-field adjust-field-grow">
                        <span class="field-label">
                          原因（必填）
                          <HelpTip
                            title="原因怎么写？"
                            :steps="['至少 4 个字', '会永久留在修正历史里，不能删除']"
                            note="写清楚依据，例如「线下赛主玩四号位，段位偏低」，方便以后回溯。"
                          />
                        </span>
                        <NInput
                          v-model:value="form.reason"
                          placeholder="例如：线下赛主玩四号位，段位偏低"
                          :maxlength="200"
                          show-count
                          @keydown.enter.prevent="save(player)"
                        />
                      </label>
                      <div class="adjust-preview">
                        <span class="adjust-preview-label">改后</span>
                        <span class="mono adjust-preview-old">{{ player.effective ?? '—' }}</span>
                        <svg class="preview-arrow" viewBox="0 0 16 16" aria-hidden="true">
                          <path
                            d="M2.8 8h10.4M9.6 4.4 13.2 8l-3.6 3.6"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="1.5"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                          />
                        </svg>
                        <span class="mono adjust-preview-new">{{ previewEffective(player) }}</span>
                      </div>
                      <div class="adjust-actions">
                        <NButton
                          type="primary"
                          attr-type="submit"
                          :disabled="saving !== null"
                          :loading="saving === player.id"
                        >
                          保存
                        </NButton>
                        <NButton :disabled="saving !== null" @click="cancelEdit">取消</NButton>
                      </div>
                    </div>
                  </form>
                </td>
              </tr>

              <tr v-if="historyFor === player.id" class="panel-row">
                <td colspan="8">
                  <div class="history-panel">
                    <div class="history-head">
                      <span class="history-title">
                        修正历史
                        <span class="muted">
                          · {{ player.displayName }} · 共 {{ history.length }} 条
                        </span>
                      </span>
                      <NButton size="small" quaternary @click="historyFor = null">收起</NButton>
                    </div>

                    <div v-if="historyLoading" class="history-empty">加载历史…</div>
                    <div v-else-if="history.length === 0" class="history-empty">还没有修正记录。</div>

                    <table v-else class="table history-table">
                      <thead>
                        <tr>
                          <th>时间</th>
                          <th class="num">修正变化</th>
                          <th class="num">最终分</th>
                          <th>原因</th>
                          <th>操作人</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr v-for="item in history" :key="item.id">
                          <td class="muted mono">{{ fmt(item.createdAt) }}</td>
                          <td class="num mono delta-track">
                            <span class="muted">{{ signed(item.oldAdjustment) }}</span>
                            <span class="delta-arrow">→</span>
                            <span :class="deltaClass(item.newAdjustment)">
                              {{ signed(item.newAdjustment) }}
                            </span>
                          </td>
                          <td class="num mono">
                            <span class="muted">{{ item.oldEffective }}</span>
                            <span class="delta-arrow">→</span>
                            {{ item.newEffective }}
                          </td>
                          <td class="history-reason">{{ item.reason }}</td>
                          <td class="muted">{{ item.operatorName ?? '—' }}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>
