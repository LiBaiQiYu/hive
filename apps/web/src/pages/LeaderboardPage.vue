<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { NButton, NSpin } from 'naive-ui';
import HelpTip from '../components/HelpTip.vue';
import { ApiError, api } from '../lib/api';
import { session } from '../lib/session';

interface Entry {
  rank: number;
  id: string;
  username: string;
  displayName: string;
  role: string;
  effective: number;
  system: number;
  adjustment: number;
  confidenceBp: number;
  wins: number;
  losses: number;
  played: number;
  winRateBp: number | null;
}

type SortKey = 'rating' | 'wins';

const entries = ref<Entry[]>([]);
const sort = ref<SortKey>('rating');
const loading = ref(true);
const error = ref('');

const meId = computed(() => session.me?.user.id ?? null);

async function load(next: SortKey = sort.value) {
  sort.value = next;
  loading.value = true;
  error.value = '';
  try {
    const data = await api<{ entries: Entry[] }>(`/leaderboard?sort=${next}`);
    entries.value = data.entries;
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '加载失败';
  } finally {
    loading.value = false;
  }
}

onMounted(() => void load());

const winRate = (entry: Entry) =>
  entry.winRateBp === null ? '—' : `${(entry.winRateBp / 100).toFixed(0)}%`;

const medal = (rank: number) => (rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `${rank}`);
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
            '② 胜场只统计已结束、且有胜负记录的比赛',
            '③ 候补与流局不计入胜场',
          ]"
          note="分数构成（段位 / 出勤）与管理员修正记录，在「我的」页可以逐项看到。"
        />
      </h1>
      <div style="display: flex; gap: 8px; align-items: center">
        <NButton :type="sort === 'rating' ? 'primary' : 'default'" size="small" @click="load('rating')">
          按评分
        </NButton>
        <NButton :type="sort === 'wins' ? 'primary' : 'default'" size="small" @click="load('wins')">
          按胜场
        </NButton>
      </div>
    </div>

    <p v-if="error" class="alert">{{ error }}</p>

    <div v-if="loading" class="empty" style="display: flex; justify-content: center; padding: 40px">
      <NSpin size="small" />
    </div>

    <div v-else-if="entries.length === 0" class="empty">还没有可排名的玩家。</div>

    <div v-else class="card" style="padding: 8px 12px">
      <table class="table">
        <thead>
          <tr>
            <th style="width: 64px">排名</th>
            <th>玩家</th>
            <th class="num">WARROOM</th>
            <th class="num">胜 / 负</th>
            <th class="num">胜率</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="entry in entries"
            :key="entry.id"
            :style="entry.id === meId ? 'background: rgba(212, 173, 51, 0.07)' : ''"
          >
            <td class="mono" style="font-size: 15px">{{ medal(entry.rank) }}</td>
            <td>
              <RouterLink
                :to="`/me`"
                style="color: var(--text); text-decoration: none"
                :title="entry.id === meId ? '这是你' : ''"
              >
                {{ entry.displayName }}
              </RouterLink>
              <span class="muted" style="font-size: 12px; margin-left: 6px">@{{ entry.username }}</span>
              <span v-if="entry.role === 'ADMIN'" class="tag tag-other" style="margin-left: 6px">管理员</span>
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
</template>
