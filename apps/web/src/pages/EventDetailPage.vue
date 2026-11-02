<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { NButton, NSelect, useMessage } from 'naive-ui';
import { ApiError, api, formatDate, STATUS_LABEL, type EventView } from '../lib/api';
import { session } from '../lib/session';
import PlayerCard, { type PlayerCardData } from '../components/PlayerCard.vue';
import HelpTip from '../components/HelpTip.vue';
import PageBack from '../components/PageBack.vue';

interface Registration {
  id: string;
  status: string;
  positionPreference: number | null;
  waitlistPosition: number | null;
}

const route = useRoute();
const event = ref<EventView | null>(null);
const mine = ref<Registration | null>(null);
const players = ref<PlayerCardData[]>([]);
const loading = ref(true);
const error = ref('');
const message = ref('');
const submitting = ref(false);

interface MatchRow {
  id: string;
  matchNo: number;
  status: string;
  ratingGap: number | null;
}

const matchList = ref<MatchRow[]>([]);

/** 报名时的主位置：0 = 不指定 */
const positionOptions = [
  { label: '不指定', value: 0 },
  ...[1, 2, 3, 4, 5].map((p) => ({ label: `${p} 号位`, value: p })),
];

async function load() {
  try {
    const id = route.params.id as string;
    const data = await api<{ event: EventView; myRegistration: Registration | null }>(
      `/events/${id}`,
    );
    event.value = data.event;
    mine.value = data.myRegistration;

    // 名单单独拉：卡片数据比赛事详情重，失败也不应该让整页白掉
    try {
      const roster = await api<{ players: PlayerCardData[] }>(`/events/${id}/registrations`);
      players.value = roster.players;
    } catch {
      players.value = [];
    }

    // 场次也单独拉：未发布时后端会过滤掉草稿
    try {
      matchList.value = await api<MatchRow[]>(`/events/${id}/matches`);
    } catch {
      matchList.value = [];
    }
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '加载失败';
  } finally {
    loading.value = false;
  }
}

onMounted(load);

const canRegister = computed(
  () => event.value?.status === 'REGISTRATION_OPEN' && !mine.value,
);
const isFull = computed(
  () => (event.value?.confirmed ?? 0) >= (event.value?.capacity ?? 0),
);
const progress = computed(() => {
  if (!event.value) return 0;
  return Math.min(100, (event.value.confirmed / event.value.capacity) * 100);
});

/** 档案里的第一志愿：选择「不指定」时，分组用的就是它 */
const profilePrimary = computed(
  () => session.me?.positions?.find((item) => item.rank === 1)?.position ?? null,
);

/** 报名时选择的主位置；0 = 不指定（后端会回退到档案里的第一志愿） */
const positionChoice = ref(0);

async function register() {
  if (!event.value) return;
  submitting.value = true;
  error.value = '';
  message.value = '';
  try {
    const data = await api<{ registration: Registration }>(
      `/events/${event.value.id}/registrations`,
      {
        method: 'POST',
        body: positionChoice.value > 0 ? { positionPreference: positionChoice.value } : {},
      },
    );
    mine.value = data.registration;
    message.value =
      data.registration.status === 'WAITLIST'
        ? '名额已满，你已进入候补队列。'
        : '报名成功，等待管理员封盘分组。';
    await load();
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '报名失败';
  } finally {
    submitting.value = false;
  }
}

async function withdraw() {
  if (!event.value) return;
  submitting.value = true;
  error.value = '';
  try {
    await api(`/events/${event.value.id}/registrations`, { method: 'DELETE' });
    mine.value = null;
    message.value = '已退赛。';
    await load();
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '退赛失败';
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="container">
    <PageBack to="/events" label="返回赛事列表" />

    <div v-if="loading" class="empty">加载中…</div>
    <div v-else-if="!event" class="empty">{{ error || '赛事不存在' }}</div>

    <template v-else>
      <section class="card">
        <div class="event-head">
          <div>
            <h1 class="event-name" style="font-size: 24px">{{ event.title }}</h1>
            <div class="event-meta" style="margin-top: 8px">
              <span>5v5 · DOTA2 · {{ event.capacity }} 人 / {{ event.targetMatches }} 场</span>
              <span v-if="event.registrationClosesAt">
                报名截止 {{ formatDate(event.registrationClosesAt) }}
              </span>
              <span v-if="event.startsAt">开赛 {{ formatDate(event.startsAt) }}</span>
            </div>
          </div>
          <span class="pill pill-idle">{{ STATUS_LABEL[event.status] ?? event.status }}</span>
        </div>

        <div class="progress" style="margin: 20px 0 10px">
          <div class="progress-bar" :style="{ width: `${progress}%` }" />
        </div>
        <div class="event-foot">
          <div>
            <span class="slots">{{ event.confirmed }} / {{ event.capacity }}</span>
            <span class="muted" style="margin-left: 12px">
              <template v-if="event.slotsToNextMatch !== null">
                再需 {{ event.slotsToNextMatch }} 人可开第
                {{ Math.floor(event.confirmed / 10) + 1 }} 场
              </template>
              <template v-else>已满员</template>
              <template v-if="event.waitlist > 0"> · 候补 {{ event.waitlist }} 人</template>
            </span>
          </div>

          <div style="display: flex; gap: 10px; align-items: center; flex-wrap: wrap">
            <label
              v-if="canRegister"
              style="display: flex; align-items: center; gap: 8px"
            >
              <span class="field-label" style="margin: 0">
                主位置
                <HelpTip
                  title="位置是怎么定的？"
                  :steps="[
                    '① 报名时选的位置只是这一次的意向',
                    '② 选「不指定」时，按「我的 → 位置偏好」里的第一志愿安排',
                    '③ 建议填满 3–5 个位置：志愿决定顺序，熟练度决定你实际能不能打',
                  ]"
                  note="报名时会把评分与位置冻结成快照；事后改档案、改评分都不会影响已公布的阵容。"
                />
              </span>
              <NSelect
                v-model:value="positionChoice"
                :options="positionOptions"
                style="width: 132px"
                size="medium"
              />
            </label>
            <NButton
              v-if="canRegister"
              type="primary"
              :disabled="submitting"
              :loading="submitting"
              @click="register"
            >
              {{ isFull ? '加入候补' : '立即报名' }}
            </NButton>
            <NButton
              v-else-if="mine"
              quaternary
              :disabled="submitting"
              :loading="submitting"
              @click="withdraw"
            >
              退赛
            </NButton>
            <RouterLink v-else-if="!session.me" to="/login" class="btn btn-primary">
              登录后报名
            </RouterLink>
          </div>
        </div>

        <p v-if="error" class="alert" style="margin-top: 16px">{{ error }}</p>
        <p v-if="message" class="muted" style="margin-top: 16px">{{ message }}</p>

        <p v-if="canRegister && !profilePrimary" class="coverage-warn" style="margin: 16px 0 0; font-size: 12px">
          档案里还没填位置偏好——分队只能把你当成「位置未知」，容易被排到不熟的位置。
          <RouterLink to="/me" style="color: var(--gold-2)">去补全 →</RouterLink>
        </p>
      </section>

      <section v-if="matchList.length > 0" class="section">
        <div class="section-head">
          <h2 class="section-title">场次</h2>
          <span class="muted" style="font-size: 13px">{{ matchList.length }} 场</span>
        </div>
        <div class="card" style="padding: 8px 12px">
          <table class="table">
            <thead>
              <tr>
                <th>场次</th>
                <th>状态</th>
                <th class="num">分差</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in matchList" :key="item.id">
                <td class="mono">第 {{ item.matchNo }} 场</td>
                <td class="muted" style="font-size: 12px">
                  {{ STATUS_LABEL[item.status] ?? item.status }}
                </td>
                <td class="num mono">{{ item.ratingGap ?? '—' }}</td>
                <td style="text-align: right">
                  <RouterLink :to="`/matches/${item.id}`" style="color: var(--gold-2); font-size: 13px">
                    查看阵容 →
                  </RouterLink>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section v-if="players.length > 0" class="section">
        <div class="section-head">
          <h2 class="section-title">报名玩家</h2>
          <span class="muted" style="font-size: 13px">{{ players.length }} 人</span>
        </div>
        <div class="card-grid">
          <PlayerCard v-for="(player, i) in players" :key="player.userId" :player="player" :index="i" />
        </div>
      </section>

      <section v-if="mine" class="section">
        <div class="card">
          <h3 class="card-title">
            我的报名
            <HelpTip
              title="快照是什么意思？"
              :steps="[
                '① 报名那一刻，你的评分与位置会存成一份快照',
                '② 之后管理员调评分、你自己改档案，都不会回写快照',
              ]"
              note="所以已经公布的阵容是稳定的：改数据不会让排好的分队悄悄变样。"
            />
          </h3>
          <p class="muted" style="margin: 0">
            状态：{{ mine.status === 'WAITLIST' ? '候补' : '已确认' }}
            <template v-if="mine.waitlistPosition">（排队第 {{ mine.waitlistPosition }} 位）</template>
            <template v-if="mine.positionPreference">
              · 主位置 {{ mine.positionPreference }} 号位
            </template>
          </p>
        </div>
      </section>
    </template>
  </div>
</template>
