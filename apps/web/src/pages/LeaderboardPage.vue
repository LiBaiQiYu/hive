<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { NSpin } from 'naive-ui';
import HelpTip from '../components/HelpTip.vue';
import RankMedal from '../components/RankMedal.vue';
import VerificationFilter from '../components/VerificationFilter.vue';
import VerificationTag from '../components/VerificationTag.vue';
import { ApiError, api } from '../lib/api';
import { mmrHint } from '../lib/rank';
import {
  filterPlayers,
  sortPlayers,
  verificationCounts,
  type PlayerListRow,
  type PlayerSortKey,
} from '../lib/player-table';
import { session } from '../lib/session';
import { nextSort, type SortState } from '../lib/sort';
import type { VerificationFilter as FilterValue } from '../lib/verification';

interface Entry extends PlayerListRow {
  username: string;
  displayName: string;
  role: string;
  system: number;
  adjustment: number;
  confidenceBp: number;
  losses: number;
  played: number;
}

const entries = ref<Entry[]>([]);
const loading = ref(true);
const error = ref('');

/** 默认按 WARROOM 降序；点表头换列，再点一次切升降 */
const sort = ref<SortState<PlayerSortKey>>({ key: 'effective', direction: 'desc' });
const filter = ref<FilterValue>('ALL');

const counts = computed(() => verificationCounts(entries.value));
const rows = computed(() => sortPlayers(filterPlayers(entries.value, filter.value), sort.value));

const meId = computed(() => session.me?.user.id ?? null);

async function load() {
  loading.value = true;
  error.value = '';
  try {
    // 排序在前端做（十几个人，不值得来回打接口）；接口只负责把数据给全
    const data = await api<{ entries: Entry[] }>('/leaderboard?limit=100');
    entries.value = data.entries;
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '加载失败';
  } finally {
    loading.value = false;
  }
}

onMounted(() => void load());

const winRate = (entry: Entry) =>
  entry.winRateBp === null || entry.winRateBp === undefined
    ? '—'
    : `${(entry.winRateBp / 100).toFixed(0)}%`;

const position = (index: number) =>
  index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}`;

function onSort(key: PlayerSortKey) {
  sort.value = nextSort(sort.value, key);
}

const sortArrow = (key: PlayerSortKey) =>
  sort.value.key === key ? (sort.value.direction === 'desc' ? '▼' : '▲') : '';
</script>

<template>
  <div class="container">
    <div class="section-head">
      <h1 class="section-title">
        排行榜
        <HelpTip
          title="这些数字是什么？"
          :steps="[
            '① WARROOM 是分队用的内部评分（0–1000），不等于天梯分',
            '② 段位与 MMR 是天梯数据，默认不参与排名，但可以点表头单独排',
            '③ 身份标签：Steam 认证 > 数字 ID 声明 > 自报，灰标不代表打得差',
          ]"
          note="段位来自 Steam / OpenDota / STRATZ 同步，MMR 只有自己填的才有。段位已经计入 WARROOM 评分，但两套排序互不影响；分数构成在「我的主页」里能看到。"
        />
      </h1>
      <span class="muted" style="font-size: 12px">共 {{ counts.ALL }} 人</span>
    </div>

    <div class="list-tools">
      <VerificationFilter v-model="filter" :counts="counts" />
      <span class="muted list-tools-hint">点表头切换排序，再点一次切升 / 降序</span>
    </div>

    <p v-if="error" class="alert">{{ error }}</p>

    <div v-if="loading" class="empty" style="display: flex; justify-content: center; padding: 40px">
      <NSpin size="small" />
    </div>

    <div v-else-if="rows.length === 0" class="empty">
      {{ counts.ALL === 0 ? '还没有可排名的玩家。' : '这个筛选下没有玩家。' }}
    </div>

    <div v-else class="card" style="padding: 8px 12px">
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th style="width: 56px">排名</th>
              <th>玩家</th>
              <th class="th-sort" @click="onSort('rankTier')">
                段位 <span class="sort-arrow">{{ sortArrow('rankTier') }}</span>
              </th>
              <th class="num th-sort" @click="onSort('mmr')">
                MMR <span class="sort-arrow">{{ sortArrow('mmr') }}</span>
              </th>
              <th class="num th-sort" @click="onSort('effective')">
                WARROOM <span class="sort-arrow">{{ sortArrow('effective') }}</span>
              </th>
              <th class="num th-sort" @click="onSort('wins')">
                胜 / 负 <span class="sort-arrow">{{ sortArrow('wins') }}</span>
              </th>
              <th class="num th-sort" @click="onSort('winRate')">
                胜率 <span class="sort-arrow">{{ sortArrow('winRate') }}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(entry, index) in rows"
              :key="entry.id"
              :style="entry.id === meId ? 'background: rgba(212, 173, 51, 0.07)' : ''"
            >
              <td class="mono" style="font-size: 15px">{{ position(index) }}</td>
              <td>
                <RouterLink
                  :to="`/players/${entry.id}`"
                  style="color: var(--text); text-decoration: none"
                  :title="entry.id === meId ? '这是你' : `看看 ${entry.displayName} 的主页`"
                >
                  {{ entry.displayName }}
                </RouterLink>
                <VerificationTag :verification="entry.verification" />
                <span class="muted" style="font-size: 12px; margin-left: 6px">@{{ entry.username }}</span>
                <span v-if="entry.role === 'ADMIN'" class="tag tag-other" style="margin-left: 6px">
                  管理员
                </span>
              </td>
              <td><RankMedal :rank-tier="entry.rankTier" /></td>
              <td class="num mono" :title="mmrHint(entry.declaredMmr, entry.rankTier, entry.rankSource)">
                <span :class="{ muted: entry.declaredMmr === null }">
                  {{ entry.declaredMmr === null ? '—' : entry.declaredMmr.toLocaleString('en-US') }}
                </span>
              </td>
              <td class="num mono" style="color: var(--gold-2); font-size: 15px">
                {{ entry.effective }}
              </td>
              <td class="num mono">
                {{ entry.wins }} / {{ entry.losses }}
                <span v-if="entry.played === 0" class="muted" style="font-size: 11px">（无记录）</span>
              </td>
              <td class="num mono">{{ winRate(entry) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
