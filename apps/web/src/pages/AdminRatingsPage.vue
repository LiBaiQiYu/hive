<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { NButton, NInput, NInputNumber, NRadioButton, NRadioGroup, NSelect, useMessage } from 'naive-ui';
import HelpTip from '../components/HelpTip.vue';
import PageBack from '../components/PageBack.vue';
import { ApiError, api } from '../lib/api';
import { MEDAL_NAMES, estimateMmrFromRank, rankLabel as rankText, rankTierFromParts } from '../lib/rank';

interface RatingRow {
  id: string;
  username: string;
  displayName: string;
  role: string;
  system: number | null;
  adjustment: number | null;
  effective: number | null;
  confidenceBp: number | null;
  attendanceBp: number | null;
  rankTier: number | null;
  declaredMmr: number | null;
  /** STRATZ / OPENDOTA / SELF_REPORTED / ADMIN_SET：决定能不能在这里改天梯分 */
  rankSource: string | null;
  limit: number;
}

interface HistoryRow {
  id: string;
  /** ADJUSTMENT = 改修正值；MMR = 设定天梯分；RANK = 设定段位（后两者来自审计日志） */
  kind: 'ADJUSTMENT' | 'MMR' | 'RANK';
  createdAt: number;
  operatorName: string | null;
  reason: string;
  oldEffective: number;
  newEffective: number;
  oldAdjustment?: number | null;
  newAdjustment?: number | null;
  oldMmr?: number | null;
  newMmr?: number | null;
  oldRankTier?: number | null;
  newRankTier?: number | null;
}

const players = ref<RatingRow[]>([]);
const loading = ref(true);
const busy = ref(false);
const saving = ref<string | null>(null);
const error = ref('');
const message = ref('');

const editing = ref<string | null>(null);
/**
 * 管理员有两种写法，二选一：
 *   MMR  —— 直接填目标天梯分（更精确，评分 = MMR ÷ 10）
 *   RANK —— 选勋章 + 星级（更直观，跟玩家自己在「我的主页」里手填段位是同一套口径）
 */
type EditMode = 'MMR' | 'RANK';
const mode = ref<EditMode>('MMR');
const form = ref<{ mmr: number | null; reason: string }>({ mmr: null, reason: '' });
const rankForm = ref<{ medal: number; star: number }>({ medal: 4, star: 1 });

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
  form.value = { mmr: player.declaredMmr ?? null, reason: '' };
  const medal = player.rankTier ? Math.floor(player.rankTier / 10) : 4;
  const star = player.rankTier ? player.rankTier % 10 : 1;
  rankForm.value = { medal: medal >= 1 && medal <= 8 ? medal : 4, star: star || 1 };
  // 打开时就落在"这个人现在有的那种数据"上：有分数先给分数，只有勋章就给段位
  mode.value = player.declaredMmr !== null || player.rankTier === null ? 'MMR' : 'RANK';
  error.value = '';
  message.value = '';
}

function cancelEdit() {
  editing.value = null;
  error.value = '';
}

/** 同步来的段位不能在这里改：下次同步会把值覆盖回去 */
function syncedSource(player: RatingRow): boolean {
  return player.rankSource === 'STRATZ' || player.rankSource === 'OPENDOTA';
}

const rankSourceLabel: Record<string, string> = {
  STRATZ: 'STRATZ 同步',
  OPENDOTA: 'OpenDota 同步',
  SELF_REPORTED: '自报',
  ADMIN_SET: '管理员设定',
};

async function save(player: RatingRow) {
  if (form.value.reason.trim().length < 4) {
    error.value = '设定原因至少 4 个字';
    return;
  }

  const rankMode = mode.value === 'RANK';
  const mmr = form.value.mmr;
  if (!rankMode && (mmr === null || !Number.isFinite(mmr))) {
    error.value = '请填写目标天梯分，或改成选段位';
    return;
  }

  saving.value = player.id;
  error.value = '';
  try {
    const body = rankMode
      ? { rankTier: pickedRankTier.value, reason: form.value.reason }
      : { mmr: Math.round(mmr as number), reason: form.value.reason };
    const result = await api<{
      mode: 'MMR' | 'RANK';
      mmr: number | null;
      rankTier: number;
      effective: number;
    }>(`/admin/ratings/players/${player.id}/declared-mmr`, { method: 'PUT', body });

    message.value =
      result.mode === 'RANK'
        ? `${player.displayName} 的段位已设为 ${rankLabel(result.rankTier)}，WARROOM ${result.effective}`
        : `${player.displayName} 的天梯分已设为 ${result.mmr}，WARROOM ${result.effective}`;
    toast.success(message.value);
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

/** 出勤率（万分比 → 百分比）；无记录显示 — */
const attendanceOf = (player: RatingRow) => {
  const bp = player.attendanceBp;
  return typeof bp === 'number' ? `${Math.round(bp / 100)}%` : '—';
};

const rankLabel = (rankTier: number | null) => rankText(rankTier) || '未填';

const medalOptions = MEDAL_NAMES.map((name, index) => ({ label: name, value: index + 1 }));
const starOptions = [1, 2, 3, 4, 5].map((s) => ({ label: `${s} 星`, value: s }));

/** 冠绝固定 80；其余按勋章 × 10 + 星级 */
const pickedRankTier = computed(() => rankTierFromParts(rankForm.value.medal, rankForm.value.star));

/** 这个段位折算成多少天梯分（后端用同一张表重算，这里只是让管理员先看见结果） */
const pickedMmr = computed(() => estimateMmrFromRank(pickedRankTier.value));

/** 与后端 computeRating 同一口径：WARROOM = clamp(round(MMR / 10), 0, 1000) */
function ratingFromMmr(mmr: number | null): number {
  if (mmr === null || !Number.isFinite(mmr)) return 0;
  return Math.min(1000, Math.max(0, Math.round(mmr / 10)));
}

/** 保存后的最终评分：人工修正在这次操作里会被清零，所以就是系统分 */
const previewEffective = computed(() =>
  mode.value === 'RANK' ? ratingFromMmr(pickedMmr.value) : ratingFromMmr(form.value.mmr),
);

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
            title="重算、修正与评分输入"
            :steps="[
              '① 重算只更新实力分（MMR ÷ 10）和出勤率，不动你设置的修正',
              '② 候补顺序：出勤率 → 实力分 → 报名时间；实力分本身不含出勤',
              '③ 「设定评分输入」二选一：填天梯分（评分 = 分数 ÷ 10），或选段位 + 星级（按勋章区间估算）',
              '④ 设定必须填原因，记录不可删除',
            ]"
            note="有人手填 20000 分把 WARROOM 顶到 1000 时，用「按天梯分」改成真实分数即可，不用自己算差值；只知道段位就切「按段位 + 星级」，系统按勋章区间折算，和玩家自己手填段位同一套口径。同步来源（STRATZ / OpenDota）的段位不能在这里改，需要玩家先解除绑定。"
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
              <th class="num">天梯分</th>
              <th class="num">系统分</th>
              <th class="num">修正</th>
              <th class="num">最终</th>
              <th class="num">置信度</th>
              <th class="num">出勤</th>
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
                <td class="num mono" :class="{ muted: player.declaredMmr === null }">
                  <template v-if="player.declaredMmr !== null">
                    {{ player.declaredMmr.toLocaleString('en-US') }}
                  </template>
                  <template v-else-if="estimateMmrFromRank(player.rankTier) !== null">
                    <span title="按段位估算：这类玩家只有勋章，没有具体天梯分">
                      ≈{{ (estimateMmrFromRank(player.rankTier) ?? 0).toLocaleString('en-US') }}
                    </span>
                  </template>
                  <template v-else>未填</template>
                </td>
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
                <td class="num mono muted" :title="player.attendanceBp === null ? '还没有已结束赛事' : '只影响候补顺序'">
                  {{ attendanceOf(player) }}
                </td>
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
                      设定
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
                <td colspan="9">
                  <form class="adjust-panel" @submit.prevent="save(player)" @keydown.esc="cancelEdit">
                    <div class="adjust-head">
                      <span class="adjust-title">设定「{{ player.displayName }}」的评分输入</span>
                      <span class="adjust-hint">
                        当前 <span class="mono">{{ player.declaredMmr ?? '未填' }}</span> · 段位
                        <span class="mono">{{ rankLabel(player.rankTier) }}</span> · 来源
                        <span class="mono">{{ rankSourceLabel[player.rankSource ?? ''] ?? '—' }}</span>
                      </span>
                    </div>

                    <div class="adjust-modes">
                      <NRadioGroup v-model:value="mode" size="small">
                        <NRadioButton value="MMR">按天梯分</NRadioButton>
                        <NRadioButton value="RANK">按段位 + 星级</NRadioButton>
                      </NRadioGroup>
                      <span class="adjust-mode-hint">
                        {{
                          mode === 'MMR'
                            ? '知道具体分数就用这个：评分 = 天梯分 ÷ 10，段位由分数反推'
                            : '只记得勋章就用这个：评分按勋章区间估算，和玩家自己手填段位同一套口径'
                        }}
                      </span>
                    </div>

                    <div class="adjust-body">
                      <label v-if="mode === 'MMR'" class="adjust-field">
                        <span class="field-label">目标天梯分</span>
                        <NInputNumber
                          v-model:value="form.mmr"
                          class="mono"
                          :min="0"
                          :max="20000"
                          :step="100"
                          :show-button="false"
                          :disabled="syncedSource(player)"
                          placeholder="例如 3000"
                          style="width: 132px"
                        />
                      </label>
                      <template v-else>
                        <label class="adjust-field">
                          <span class="field-label">勋章</span>
                          <NSelect
                            v-model:value="rankForm.medal"
                            :options="medalOptions"
                            :disabled="syncedSource(player)"
                            style="width: 132px"
                          />
                        </label>
                        <label class="adjust-field">
                          <span class="field-label">星级</span>
                          <NSelect
                            v-if="rankForm.medal !== 8"
                            v-model:value="rankForm.star"
                            :options="starOptions"
                            :disabled="syncedSource(player)"
                            style="width: 96px"
                          />
                          <span v-else class="adjust-star-none mono">冠绝无星级</span>
                        </label>
                        <div class="adjust-field">
                          <span class="field-label">折算天梯分</span>
                          <span class="mono adjust-derived">≈ {{ pickedMmr ?? '—' }}</span>
                        </div>
                      </template>
                      <label class="adjust-field adjust-field-grow">
                        <span class="field-label">
                          原因（必填）
                          <HelpTip
                            title="原因怎么写？"
                            :steps="['至少 4 个字', '会永久留在变更历史里，不能删除']"
                            note="写清楚依据，例如「本人确认实际 3000 分，手填的分错了」，方便以后回溯。"
                          />
                        </span>
                        <NInput
                          v-model:value="form.reason"
                          placeholder="例如：本人确认实际 3000 分，之前手填有误"
                          :maxlength="200"
                          show-count
                          @keydown.enter.prevent="save(player)"
                        />
                      </label>
                      <div class="adjust-preview">
                        <span class="adjust-preview-label">WARROOM</span>
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
                        <span class="mono adjust-preview-new">{{ previewEffective }}</span>
                      </div>
                      <div class="adjust-actions">
                        <NButton
                          type="primary"
                          attr-type="submit"
                          :disabled="saving !== null || syncedSource(player)"
                          :loading="saving === player.id"
                        >
                          保存
                        </NButton>
                        <NButton :disabled="saving !== null" @click="cancelEdit">取消</NButton>
                      </div>
                    </div>

                    <p v-if="syncedSource(player)" class="adjust-note">
                      该玩家的段位来自{{ rankSourceLabel[player.rankSource ?? ''] ?? '第三方同步' }}，
                      改了会在下次同步时被覆盖。请先让玩家解除绑定，或改用评分修正。
                    </p>
                    <p v-else-if="mode === 'RANK'" class="adjust-note">
                      段位模式不写具体天梯分：{{ rankLabel(pickedRankTier) }} ≈
                      {{ pickedMmr }} 分，评分按勋章区间算出 {{ previewEffective }}。保存后这个段位记在
                      管理员名下，玩家自己改不动，要调整得再来找你。
                    </p>
                    <p v-else-if="(player.adjustment ?? 0) !== 0" class="adjust-note">
                      该玩家当前有 {{ signed(player.adjustment) }} 的人工修正，保存后会清零，
                      最终分正好等于「目标天梯分 ÷ 10」。
                    </p>
                  </form>
                </td>
              </tr>

              <tr v-if="historyFor === player.id" class="panel-row">
                <td colspan="9">
                  <div class="history-panel">
                    <div class="history-head">
                      <span class="history-title">
                        评分变更历史
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
                          <th class="num">变更</th>
                          <th class="num">最终分</th>
                          <th>原因</th>
                          <th>操作人</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr v-for="item in history" :key="item.id">
                          <td class="muted mono">{{ fmt(item.createdAt) }}</td>
                          <td class="num mono delta-track">
                            <template v-if="item.kind === 'MMR'">
                              <span class="muted">天梯分</span>
                              <span class="muted">{{ item.oldMmr ?? '未填' }}</span>
                              <span class="delta-arrow">→</span>
                              <span>{{ item.newMmr }}</span>
                            </template>
                            <template v-else-if="item.kind === 'RANK'">
                              <span class="muted">段位</span>
                              <span class="muted">{{ rankLabel(item.oldRankTier ?? null) }}</span>
                              <span class="delta-arrow">→</span>
                              <span>{{ rankLabel(item.newRankTier ?? null) }}</span>
                            </template>
                            <template v-else>
                              <span class="muted">{{ signed(item.oldAdjustment ?? 0) }}</span>
                              <span class="delta-arrow">→</span>
                              <span :class="deltaClass(item.newAdjustment ?? 0)">
                                {{ signed(item.newAdjustment ?? 0) }}
                              </span>
                            </template>
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
