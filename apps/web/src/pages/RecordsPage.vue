<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { NSpin } from 'naive-ui';
import HelpTip from '../components/HelpTip.vue';
import RankMedal from '../components/RankMedal.vue';
import VerificationFilter from '../components/VerificationFilter.vue';
import VerificationTag from '../components/VerificationTag.vue';
import { ApiError, api, formatDate } from '../lib/api';
import { mmrHint } from '../lib/rank';
import {
  filterPlayers,
  sortPlayers,
  verificationCounts,
  type PlayerListRow,
  type PlayerSortKey,
} from '../lib/player-table';
import { loadMe, session } from '../lib/session';
import { nextSort, type SortState } from '../lib/sort';
import type { VerificationFilter as FilterValue } from '../lib/verification';

interface MyMatch {
  matchId: string;
  matchNo: number;
  eventId: string;
  eventTitle: string;
  side: 'RADIANT' | 'DIRE';
  won: boolean;
  durationSeconds: number | null;
  playedAt: number | null;
}

interface Summary {
  played: number;
  wins: number;
  losses: number;
  winRateBp: number | null;
}

interface LeaderRow extends PlayerListRow {
  displayName: string;
  username: string;
  losses: number;
  played: number;
}

const loading = ref(true);
const error = ref('');
const summary = ref<Summary | null>(null);
const matches = ref<MyMatch[]>([]);
const board = ref<LeaderRow[]>([]);

/** 全员胜场默认按胜场降序；点表头可以换段位 / MMR / WARROOM / 胜率 */
const filter = ref<FilterValue>('ALL');
const sort = ref<SortState<PlayerSortKey>>({ key: 'wins', direction: 'desc' });
const counts = computed(() => verificationCounts(board.value));
const boardRows = computed(() =>
  sortPlayers(filterPlayers(board.value, filter.value), sort.value),
);

function onSort(key: PlayerSortKey) {
  sort.value = nextSort(sort.value, key);
}

const sortArrow = (key: PlayerSortKey) =>
  sort.value.key === key ? (sort.value.direction === 'desc' ? '▼' : '▲') : '';

const loggedIn = computed(() => !!session.me);
const meId = computed(() => session.me?.user.id ?? null);

async function load() {
  loading.value = true;
  error.value = '';
  try {
    // 全员胜场对游客也可见；"我的对局"要登录。
    // 排序在前端做（十几个人），接口只负责把数据给全。
    const [community] = await Promise.all([
      api<{ entries: LeaderRow[] }>('/leaderboard?limit=100'),
    ]);
    board.value = community.entries;

    if (session.me) {
      const mine = await api<{ summary: Summary; matches: MyMatch[] }>('/me/matches');
      summary.value = mine.summary;
      matches.value = mine.matches;
    }
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '加载失败';
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  if (!session.ready) await loadMe();
  await load();
});

const pct = (bp: number | null) => (bp === null ? '—' : `${(bp / 100).toFixed(0)}%`);

function duration(seconds: number | null): string {
  if (!seconds) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
</script>

<template>
  <div class="container">
    <div class="section-head">
      <h1 class="section-title">
        战绩
        <HelpTip
          title="战绩怎么算？"
          :steps="[
            '① 只统计已结束、有胜负记录的对局',
            '② 候补与流局不计入',
            '③ 胜率 = 胜 /（胜 + 负），没有记录时显示「—」',
          ]"
          note="这里的数据来自管理员录入的赛果；评委分与修正记录不在这里，见「我的」。"
        />
      </h1>
    </div>

    <p v-if="error" class="alert">{{ error }}</p>

    <div v-if="loading" class="empty" style="display: flex; justify-content: center; padding: 40px">
      <NSpin size="small" />
    </div>

    <template v-else>
      <!-- 我的对局 -->
      <section class="section">
        <h2 class="section-title" style="margin-bottom: 12px">我的对局</h2>

        <div v-if="!loggedIn" class="empty">
          请先 <RouterLink to="/login" style="color: var(--gold-2)">登录</RouterLink> 查看自己的战绩。
        </div>

        <template v-else>
          <div class="record-stats">
            <div class="record-stat">
              <div class="stat-label">场次</div>
              <div class="record-value mono">{{ summary?.played ?? 0 }}</div>
            </div>
            <div class="record-stat">
              <div class="stat-label">胜</div>
              <div class="record-value mono" style="color: var(--radiant)">
                {{ summary?.wins ?? 0 }}
              </div>
            </div>
            <div class="record-stat">
              <div class="stat-label">负</div>
              <div class="record-value mono" style="color: var(--dire)">
                {{ summary?.losses ?? 0 }}
              </div>
            </div>
            <div class="record-stat">
              <div class="stat-label">胜率</div>
              <div class="record-value mono">{{ pct(summary?.winRateBp ?? null) }}</div>
            </div>
          </div>

          <div v-if="matches.length === 0" class="empty" style="margin-top: 14px">
            还没有打完的比赛。等管理员录入胜负后，这里就会出现记录。
          </div>

          <div v-else class="card" style="padding: 8px 12px; margin-top: 14px">
            <table class="table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>赛事</th>
                  <th class="num">场次</th>
                  <th>我方</th>
                  <th>结果</th>
                  <th class="num">时长</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="item in matches" :key="item.matchId">
                  <td class="muted">{{ formatDate(item.playedAt) }}</td>
                  <td>
                    <RouterLink
                      :to="`/events/${item.eventId}`"
                      style="color: var(--text); text-decoration: none"
                    >
                      {{ item.eventTitle }}
                    </RouterLink>
                  </td>
                  <td class="num mono">第 {{ item.matchNo }} 场</td>
                  <td>
                    <span class="muted">
                      {{ item.side === 'RADIANT' ? '天辉' : '夜魇' }}
                    </span>
                  </td>
                  <td>
                    <span :class="item.won ? 'tag tag-confirmed' : 'tag tag-other'">
                      {{ item.won ? '胜' : '负' }}
                    </span>
                  </td>
                  <td class="num mono muted">{{ duration(item.durationSeconds) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </section>

      <!-- 全员胜场 -->
      <section class="section">
        <div class="section-head">
          <h2 class="section-title">全员胜场</h2>
          <RouterLink to="/leaderboard" class="muted" style="font-size: 12px">
            完整排行榜 →
          </RouterLink>
        </div>

        <div v-if="board.length === 0" class="empty">还没有打完的比赛。</div>

        <template v-else>
          <div class="list-tools">
            <VerificationFilter v-model="filter" :counts="counts" />
            <span class="muted list-tools-hint">点表头切换排序</span>
          </div>

          <div v-if="boardRows.length === 0" class="empty">这个筛选下没有玩家。</div>

          <div v-else class="card" style="padding: 8px 12px">
            <div class="table-wrap">
              <table class="table">
                <thead>
                  <tr>
                    <th style="width: 56px" class="num">#</th>
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
                    v-for="(row, index) in boardRows"
                    :key="row.id"
                    :style="row.id === meId ? 'background: rgba(212, 173, 51, 0.07)' : ''"
                  >
                    <td class="num mono">{{ index + 1 }}</td>
                    <td>
                      <RouterLink
                        :to="`/players/${row.id}`"
                        style="color: var(--text); text-decoration: none"
                        :title="row.id === meId ? '这是你' : `看看 ${row.displayName} 的主页`"
                      >
                        {{ row.displayName }}
                      </RouterLink>
                      <VerificationTag :verification="row.verification" />
                      <span class="muted" style="font-size: 12px; margin-left: 6px">
                        @{{ row.username }}
                      </span>
                    </td>
                    <td><RankMedal :rank-tier="row.rankTier" /></td>
                    <td
                      class="num mono"
                      :title="mmrHint(row.declaredMmr, row.rankTier, row.rankSource)"
                    >
                      <span :class="{ muted: row.declaredMmr === null }">
                        {{ row.declaredMmr === null ? '—' : row.declaredMmr.toLocaleString('en-US') }}
                      </span>
                    </td>
                    <td class="num mono" style="color: var(--gold-2); font-size: 15px">
                      {{ row.effective }}
                    </td>
                    <td class="num mono">{{ row.wins }} / {{ row.losses }}</td>
                    <td class="num mono">{{ pct(row.winRateBp ?? null) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </template>
      </section>
    </template>
  </div>
</template>
