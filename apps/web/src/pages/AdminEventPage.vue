<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { ApiError, api, formatDate, STATUS_LABEL, type EventView } from '../lib/api';

interface RegRow {
  id: string;
  userId: string;
  displayName: string;
  username: string;
  status: string;
  position: number | null;
  waitlistPosition: number | null;
  effectiveRating: number;
}

interface MatchRow {
  id: string;
  matchNo: number;
  title: string | null;
  status: string;
  ratingGap: number | null;
  seed: number | null;
  version: number;
  memberCount: number;
  radiantWin: number | null;
  durationSeconds: number | null;
  completedAt: number | null;
}

interface LineupTeam {
  side: string;
  totalRating: number;
  positionCoverageBp: number;
  members: { userId: string; displayName: string; position: number; fitScore: number }[];
}

const route = useRoute();
const eventId = route.params.id as string;

const event = ref<EventView | null>(null);
const regs = ref<RegRow[]>([]);
const matches = ref<MatchRow[]>([]);
const lineup = ref<{ match: { id: string; status: string; teams: LineupTeam[] } } | null>(null);

const loading = ref(true);
const busy = ref(false);
const error = ref('');
const message = ref('');

const seed = ref(0);
const policy = ref<'START_PARTIAL' | 'EXTEND' | 'CANCEL'>('START_PARTIAL');
const matchNo = ref(1);

const confirmed = computed(() => regs.value.filter((r) => r.status === 'CONFIRMED'));
const waitlist = computed(() => regs.value.filter((r) => r.status === 'WAITLIST'));
const canForm = computed(() => Math.floor(confirmed.value.length / 10));
const odd = computed(() => confirmed.value.length % 10 !== 0 && confirmed.value.length >= 10);

async function refresh() {
  loading.value = true;
  error.value = '';
  try {
    const detail = await api<{ event: EventView }>(`/events/${eventId}`);
    event.value = detail.event;
    const detailRegs = await api<{ registrations: RegRow[] }>(
      `/admin/events/${eventId}/registrations`,
    );
    regs.value = detailRegs.registrations;
    matches.value = await api<MatchRow[]>(`/events/${eventId}/matches`);
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '加载失败';
  } finally {
    loading.value = false;
  }
}

onMounted(refresh);

async function run<T>(action: () => Promise<T>, okMessage: string) {
  busy.value = true;
  error.value = '';
  message.value = '';
  try {
    await action();
    message.value = okMessage;
    lineup.value = null;
    await refresh();
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '操作失败';
  } finally {
    busy.value = false;
  }
}

const transition = (to: string) =>
  run(
    () => api(`/admin/events/${eventId}/transition`, { method: 'POST', body: { to } }),
    `状态已切换为 ${STATUS_LABEL[to] ?? to}`,
  );

const finalize = () =>
  run(
    () => api(`/admin/events/${eventId}/finalize`, { method: 'POST', body: { policy: policy.value } }),
    '封盘完成',
  );

const generate = () =>
  run(
    () =>
      api(`/admin/matches/generate`, {
        method: 'POST',
        body: { eventId, matchNo: matchNo.value, seed: seed.value },
      }),
    '阵容已生成（草稿，未发布）',
  );

const publish = (matchId: string) =>
  run(() => api(`/admin/matches/${matchId}/publish`, { method: 'POST', body: {} }), '阵容已发布');

/** 每场比赛单独记一个时长效，避免给多场比赛共享一个输入框 */
const durations = ref<Record<string, number | undefined>>({});

const record = (matchId: string, radiantWin: boolean) =>
  run(
    () =>
      api(`/admin/matches/${matchId}/result`, {
        method: 'POST',
        body: {
          radiantWin,
          durationSeconds:
            typeof durations.value[matchId] === 'number' ? durations.value[matchId] : undefined,
        },
      }),
    radiantWin ? '已记录：Radiant 胜' : '已记录：Dire 胜',
  );

const voidMatch = (matchId: string) =>
  run(
    () => api(`/admin/matches/${matchId}/void`, { method: 'POST', body: { reason: '管理员流局' } }),
    '已流局（数据保留，战绩与审计不受影响）',
  );

function formatDuration(seconds: number | null): string {
  if (!seconds) return '';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

async function viewLineup(matchId: string) {
  busy.value = true;
  error.value = '';
  try {
    lineup.value = await api(`/admin/matches/${matchId}/lineup`);
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '加载阵容失败';
  } finally {
    busy.value = false;
  }
}

const statusPill = (status: string) => {
  if (status === 'REGISTRATION_OPEN') return 'pill pill-open';
  if (status === 'PUBLISHED') return 'pill pill-published';
  if (status === 'DRAFT') return 'pill pill-idle';
  return 'pill pill-closed';
};
</script>

<template>
  <div class="container">
    <div class="section-head">
      <RouterLink to="/admin" class="muted" style="font-size: 13px">← 返回后台</RouterLink>
    </div>

    <div v-if="loading" class="empty">加载中…</div>
    <div v-else-if="!event" class="empty">{{ error || '赛事不存在' }}</div>

    <template v-else>
      <section class="card">
        <div class="event-head">
          <div>
            <h1 class="event-name" style="font-size: 22px">{{ event.title }}</h1>
            <div class="event-meta" style="margin-top: 8px">
              <span>目标 {{ event.capacity }} 人 / {{ event.targetMatches }} 场</span>
              <span>报名截止 {{ formatDate(event.registrationClosesAt) }}</span>
              <span>开赛 {{ formatDate(event.startsAt) }}</span>
            </div>
          </div>
          <span :class="statusPill(event.status)">
            {{ STATUS_LABEL[event.status] ?? event.status }}
          </span>
        </div>

        <div class="toolbar" style="margin-top: 18px">
          <button
            v-if="event.status === 'DRAFT'"
            class="btn btn-primary"
            :disabled="busy"
            @click="transition('REGISTRATION_OPEN')"
          >
            开放报名
          </button>
          <button
            v-if="event.status === 'REGISTRATION_OPEN'"
            class="btn"
            :disabled="busy"
            @click="transition('REGISTRATION_CLOSED')"
          >
            关闭报名
          </button>

          <template v-if="event.status === 'REGISTRATION_CLOSED'">
            <select v-model="policy" class="input" style="width: 190px">
              <option value="START_PARTIAL">按现有人数开局</option>
              <option value="EXTEND">延长报名 2 小时</option>
              <option value="CANCEL">取消赛事</option>
            </select>
            <button class="btn btn-primary" :disabled="busy" @click="finalize">封盘结算</button>
          </template>

          <template v-if="event.status === 'REGISTRATION_CLOSED' || event.status === 'PUBLISHED'">
            <span class="muted" style="font-size: 12px">第</span>
            <input v-model.number="matchNo" class="input" type="number" min="1" max="10" style="width: 64px" />
            <span class="muted" style="font-size: 12px">场 · seed</span>
            <input v-model.number="seed" class="input" type="number" min="0" style="width: 84px" />
            <button class="btn" :disabled="busy" @click="generate">生成阵容</button>
          </template>

          <button class="btn btn-ghost" :disabled="busy" @click="refresh">刷新</button>
        </div>

        <p v-if="odd" class="coverage-warn" style="margin-top: 12px">
          {{ confirmed.length }} 人只能开 {{ canForm }} 场，余 {{ confirmed.length - canForm * 10 }} 人需要进候补。
          封盘时请选「按现有人数开局」或「延长报名」。
        </p>
        <p v-if="error" class="alert" style="margin-top: 12px">{{ error }}</p>
        <p v-if="message" class="muted" style="margin-top: 12px">{{ message }}</p>
      </section>

      <!-- 场次 -->
      <section class="section">
        <h2 class="section-title" style="margin-bottom: 12px">场次</h2>
        <div v-if="matches.length === 0" class="empty">还没有生成阵容。</div>
        <div v-else class="card">
          <div v-for="match in matches" :key="match.id" class="match-row" style="flex-wrap: wrap">
            <div>
              <span class="mono">第 {{ match.matchNo }} 场</span>
              <span :class="statusPill(match.status)" style="margin-left: 10px">
                {{
                  match.status === 'DRAFT'
                    ? '草稿'
                    : match.status === 'COMPLETED'
                      ? '已结束'
                      : match.status === 'VOID'
                        ? '流局'
                        : match.status
                }}
              </span>
              <span class="muted" style="margin-left: 12px; font-size: 12px">
                {{ match.memberCount }} 人 · 分差 {{ match.ratingGap ?? '—' }} · v{{ match.version }}
              </span>
              <span
                v-if="match.status === 'COMPLETED'"
                class="mono"
                style="margin-left: 10px; color: var(--gold-2); font-size: 12px"
              >
                {{ match.radiantWin ? 'Radiant 胜' : 'Dire 胜' }}
                <template v-if="match.durationSeconds">
                  · {{ formatDuration(match.durationSeconds) }}
                </template>
              </span>
            </div>

            <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap">
              <template v-if="match.status === 'PUBLISHED' || match.status === 'IN_PROGRESS'">
                <input
                  v-model.number="durations[match.id]"
                  class="input"
                  type="number"
                  min="300"
                  max="14400"
                  placeholder="时长(秒)"
                  style="width: 110px; padding: 6px 8px"
                />
                <button class="btn btn-ghost" :disabled="busy" @click="record(match.id, true)">
                  Radiant 胜
                </button>
                <button class="btn btn-ghost" :disabled="busy" @click="record(match.id, false)">
                  Dire 胜
                </button>
                <button class="btn btn-ghost" :disabled="busy" @click="voidMatch(match.id)">
                  流局
                </button>
              </template>
              <button class="btn btn-ghost" :disabled="busy" @click="viewLineup(match.id)">
                查看阵容
              </button>
              <button
                v-if="match.status === 'DRAFT'"
                class="btn btn-primary"
                :disabled="busy"
                @click="publish(match.id)"
              >
                发布
              </button>
            </div>
          </div>
        </div>
      </section>

      <!-- 阵容预览 -->
      <section v-if="lineup" class="section">
        <h2 class="section-title" style="margin-bottom: 12px">阵容预览</h2>
        <div class="match-board">
          <div
            v-for="team in lineup.match.teams"
            :key="team.side"
            class="team"
            :class="team.side === 'RADIANT' ? 'team-radiant' : 'team-dire'"
          >
            <div class="team-name">
              <span>{{ team.side }}</span>
              <span class="mono">{{ team.totalRating }}</span>
            </div>
            <div v-for="member in team.members" :key="member.userId" class="slot">
              <span class="slot-pos">{{ member.position }} 号位</span>
              <span class="slot-name">{{ member.displayName }}</span>
              <span
                class="slot-rating"
                :style="member.fitScore < 40 ? 'color: var(--amber)' : ''"
                title="位置契合度"
              >
                {{ member.fitScore }}
              </span>
            </div>
          </div>
        </div>
      </section>

      <!-- 报名名单 -->
      <section class="section">
        <div class="section-head">
          <h2 class="section-title">报名名单</h2>
          <span class="muted" style="font-size: 13px">
            {{ confirmed.length }} 正选 / {{ waitlist.length }} 候补
          </span>
        </div>

        <div v-if="regs.length === 0" class="empty">还没有人报名。</div>
        <div v-else class="card" style="padding: 8px 12px">
          <table class="table">
            <thead>
              <tr>
                <th>玩家</th>
                <th>状态</th>
                <th class="num">评分</th>
                <th>位置</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="reg in regs" :key="reg.id">
                <td>
                  {{ reg.displayName }}
                  <span class="muted" style="font-size: 12px">@{{ reg.username }}</span>
                </td>
                <td>
                  <span
                    class="tag"
                    :class="
                      reg.status === 'CONFIRMED'
                        ? 'tag-confirmed'
                        : reg.status === 'WAITLIST'
                          ? 'tag-waitlist'
                          : 'tag-other'
                    "
                  >
                    {{
                      reg.status === 'CONFIRMED'
                        ? '正选'
                        : reg.status === 'WAITLIST'
                          ? `候补 ${reg.waitlistPosition ?? ''}`
                          : reg.status
                    }}
                  </span>
                </td>
                <td class="num mono">{{ reg.effectiveRating }}</td>
                <td class="muted">{{ reg.position ? `${reg.position} 号位` : '未填' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>
  </div>
</template>
