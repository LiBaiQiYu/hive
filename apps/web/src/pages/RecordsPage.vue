<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { NSpin } from 'naive-ui';
import HelpTip from '../components/HelpTip.vue';
import { ApiError, api, formatDate } from '../lib/api';
import { loadMe, session } from '../lib/session';

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

interface LeaderRow {
  rank: number;
  id: string;
  displayName: string;
  username: string;
  wins: number;
  losses: number;
  played: number;
  winRateBp: number | null;
}

const loading = ref(true);
const error = ref('');
const summary = ref<Summary | null>(null);
const matches = ref<MyMatch[]>([]);
const board = ref<LeaderRow[]>([]);

const loggedIn = computed(() => !!session.me);
const meId = computed(() => session.me?.user.id ?? null);

async function load() {
  loading.value = true;
  error.value = '';
  try {
    // 全员胜场对游客也可见；"我的对局"要登录
    const [community] = await Promise.all([
      api<{ entries: LeaderRow[] }>('/leaderboard?sort=wins&limit=50'),
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

        <div v-else class="card" style="padding: 8px 12px">
          <table class="table">
            <thead>
              <tr>
                <th style="width: 56px" class="num">#</th>
                <th>玩家</th>
                <th class="num">胜 / 负</th>
                <th class="num">胜率</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in board"
                :key="row.id"
                :style="row.id === meId ? 'background: rgba(212, 173, 51, 0.07)' : ''"
              >
                <td class="num mono">{{ row.rank }}</td>
                <td>
                  {{ row.displayName }}
                  <span class="muted" style="font-size: 12px; margin-left: 6px">@{{ row.username }}</span>
                </td>
                <td class="num mono">{{ row.wins }} / {{ row.losses }}</td>
                <td class="num mono">{{ pct(row.winRateBp) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>
  </div>
</template>
