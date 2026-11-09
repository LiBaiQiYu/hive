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
    </template>
  </div>
</template>
