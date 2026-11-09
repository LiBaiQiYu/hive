<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { NButton, NSpin } from 'naive-ui';
import { ApiError, api, formatDate, STATUS_LABEL, type EventView } from '../lib/api';
import { formatDuration } from '../lib/duration';
import { session } from '../lib/session';
import PageBack from '../components/PageBack.vue';

interface Member {
  id: string;
  /** 临时参赛者没有账号 */
  userId: string | null;
  displayName: string | null;
  isGuest: number;
  position: number;
  fitScore: number;
  effectiveRating: number;
  /** 被这个替补换下去的人；原生阵容为 null */
  replacedName?: string | null;
  /** 换人的原因：ABSENT = 本人没来（计入弃赛），MANUAL = 临场调整 */
  replaceReason?: 'ABSENT' | 'MANUAL' | null;
}

interface Team {
  side: 'RADIANT' | 'DIRE';
  name: string;
  totalRating: number;
  averageRating: number;
  positionCoverageBp: number;
  members: Member[];
}

type BenchReason = 'WAITLIST' | 'ABSENT' | 'SUBSTITUTED' | 'WITHDRAWN';

/** 报了名却没出现在这套阵容里的人和原因（服务端算好，见 services/bench.ts） */
interface BenchRow {
  userId: string | null;
  displayName: string;
  position: number | null;
  reason: BenchReason;
  rank: number | null;
  detail: string | null;
}

interface MatchView {
  match: {
    id: string;
    eventId: string;
    matchNo: number;
    title: string | null;
    status: string;
    ratingGap: number | null;
    radiantWin: number | null;
    durationSeconds: number | null;
    completedAt: number | null;
    scheduledAt: number | null;
    version: number;
    teams: Team[];
    bench: BenchRow[];
  };
}

const route = useRoute();
const match = ref<MatchView['match'] | null>(null);
const event = ref<EventView | null>(null);
const loading = ref(true);
const error = ref('');

const isAdmin = computed(() => session.me?.user.role === 'ADMIN');

onMounted(async () => {
  try {
    const data = await api<MatchView>(`/matches/${route.params.id}`);
    match.value = data.match;
    // 赛事信息单独拉：失败不影响阵容展示
    try {
      const detail = await api<{ event: EventView }>(`/events/${data.match.eventId}`);
      event.value = detail.event;
    } catch {
      event.value = null;
    }
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '加载失败';
  } finally {
    loading.value = false;
  }
});

const teamOf = (side: 'RADIANT' | 'DIRE') =>
  match.value?.teams.find((team) => team.side === side) ?? null;

const slots = (team: Team | null) => {
  const byPosition = new Map((team?.members ?? []).map((member) => [member.position, member]));
  return [1, 2, 3, 4, 5].map((position) => ({ position, member: byPosition.get(position) ?? null }));
};

const won = computed(() => {
  const current = match.value;
  if (!current || current.radiantWin === null) return null;
  return current.radiantWin === 1 ? 'RADIANT' : 'DIRE';
});

/** 原因标签：文案只活在前端，服务端只给枚举 */
const BENCH_LABEL: Record<BenchReason, string> = {
  WAITLIST: '候补',
  ABSENT: '弃赛',
  SUBSTITUTED: '临场换下',
  WITHDRAWN: '退赛',
};

const bench = computed(() => match.value?.bench ?? []);
</script>

<template>
  <div class="container">
    <div v-if="loading" class="empty" style="display: flex; justify-content: center; padding: 40px">
      <NSpin size="small" />
    </div>

    <div v-else-if="!match" class="empty">{{ error || '比赛不存在或还未发布' }}</div>

    <template v-else>
      <!-- 从赛事详情、玩家战绩、管理员赛事页都能进来：先回上一页，站外打开才回落到赛事 -->
      <PageBack back :to="`/events/${match.eventId}`" :label="`返回${event?.title ?? '赛事'}`" />

      <section class="card">
        <div class="event-head">
          <div>
            <h1 class="event-name" style="font-size: 22px">
              第 {{ match.matchNo }} 场
              <span
                v-if="match.title && match.title !== `第 ${match.matchNo} 场`"
                class="muted"
                style="font-size: 15px"
              >
                · {{ match.title }}
              </span>
            </h1>
            <div class="event-meta" style="margin-top: 8px">
              <span>分差 <span class="mono">{{ match.ratingGap ?? '—' }}</span></span>
              <span v-if="match.completedAt">结束于 {{ formatDate(match.completedAt) }}</span>
              <span v-else-if="match.scheduledAt">计划 {{ formatDate(match.scheduledAt) }}</span>
              <span v-if="match.durationSeconds">时长 {{ formatDuration(match.durationSeconds) }}</span>
            </div>
          </div>
          <span class="pill pill-published">{{ STATUS_LABEL[match.status] ?? match.status }}</span>
        </div>

        <p
          v-if="won"
          style="margin: 14px 0 0; font-size: 15px"
          :style="{ color: won === 'RADIANT' ? 'var(--radiant)' : 'var(--dire)' }"
        >
          {{ won === 'RADIANT' ? '天辉' : '夜魇' }}获胜
        </p>

        <p v-if="isAdmin && match.status === 'DRAFT'" class="muted" style="margin: 14px 0 0; font-size: 12px">
          这是草稿阵容，只有管理员能看到。
          <RouterLink :to="`/admin/events/${match.eventId}`" style="color: var(--gold-2)">
            去后台调整 →
          </RouterLink>
        </p>
      </section>

      <section class="section">
        <div class="match-board">
          <div
            v-for="side in (['RADIANT', 'DIRE'] as const)"
            :key="side"
            class="team"
            :class="side === 'RADIANT' ? 'team-radiant' : 'team-dire'"
          >
            <div class="team-name">
              <span>{{ side === 'RADIANT' ? '天辉 RADIANT' : '夜魇 DIRE' }}</span>
              <span class="mono">{{ teamOf(side)?.totalRating ?? 0 }}</span>
            </div>
            <div v-for="slot in slots(teamOf(side))" :key="slot.position" class="slot">
              <span class="slot-pos">{{ slot.position }} 号位</span>
              <template v-if="slot.member">
                <RouterLink
                  v-if="slot.member.userId && !slot.member.isGuest"
                  class="slot-name slot-name-link"
                  :to="`/players/${slot.member.userId}`"
                  :title="`看看 ${slot.member.displayName} 的主页`"
                >{{ slot.member.displayName }}</RouterLink>
                <span v-else class="slot-name">
                  {{ slot.member.displayName }}
                  <span class="slot-guest-tag">临时</span>
                  <span
                    v-if="slot.member.replacedName"
                    class="slot-replaced"
                    :title="
                      slot.member.replaceReason === 'MANUAL'
                        ? `临场调整：${slot.member.replacedName} 换下`
                        : `${slot.member.replacedName} 报名后未到场，由临时参赛者顶替`
                    "
                  >
                    替 {{ slot.member.replacedName }}
                  </span>
                </span>
                <span
                  class="slot-rating"
                  :style="slot.member.fitScore < 40 ? 'color: var(--amber)' : ''"
                  title="位置契合度"
                >
                  {{ slot.member.fitScore }}
                </span>
              </template>
              <span v-else class="muted" style="font-size: 12px">空</span>
            </div>
          </div>
        </div>
      </section>

      <p class="muted" style="font-size: 11px; margin-top: 6px">
        括号里的数字是位置契合度（0–100）：低于 40 说明这个人不常打这个位置。
        阵容在发布时冻结，之后改评分或改偏好都不会让已公布的分队发生变化。
      </p>

      <!-- 没进阵容的人：候补、本场被换下的、退赛的。原因由服务端归因，前端只负责讲清楚 -->
      <section v-if="bench.length > 0" class="section">
        <div class="section-head">
          <h2 class="section-title">未进阵容</h2>
          <span class="muted" style="font-size: 13px">{{ bench.length }} 人</span>
        </div>

        <div class="card bench-card">
          <div v-for="row in bench" :key="`${row.userId ?? row.displayName}-${row.reason}`" class="bench-row">
            <span class="bench-tag" :data-reason="row.reason">{{ BENCH_LABEL[row.reason] }}</span>

            <RouterLink
              v-if="row.userId"
              class="bench-name slot-name-link"
              :to="`/players/${row.userId}`"
              :title="`看看 ${row.displayName} 的主页`"
            >{{ row.displayName }}</RouterLink>
            <span v-else class="bench-name">{{ row.displayName }}</span>

            <span class="bench-pos muted">
              {{ row.position ? `${row.position} 号位` : '位置未填' }}
            </span>
            <span class="bench-detail muted">{{ row.detail }}</span>
          </div>

          <dl class="bench-legend">
            <div>
              <dt><span class="bench-tag" data-reason="WAITLIST">候补</span></dt>
              <dd class="muted">
                报名人数超出容量（每一场 10 人），按「出勤率 → 实力分 → 报名时间」排位，有人退赛时依次补上。
              </dd>
            </div>
            <div>
              <dt><span class="bench-tag" data-reason="ABSENT">弃赛</span></dt>
              <dd class="muted">
                报名后没到场，位置由临时参赛者顶替；该场计入弃赛，不计胜负与出勤。
              </dd>
            </div>
            <div>
              <dt><span class="bench-tag" data-reason="SUBSTITUTED">临场换下</span></dt>
              <dd class="muted">管理员在本场做了调整（人到了但不打这个位置），不算弃赛。</dd>
            </div>
            <div>
              <dt><span class="bench-tag" data-reason="WITHDRAWN">退赛</span></dt>
              <dd class="muted">在报名截止前主动退出，不占名额、也不计入任何统计。</dd>
            </div>
          </dl>
        </div>
      </section>
    </template>
  </div>
</template>
