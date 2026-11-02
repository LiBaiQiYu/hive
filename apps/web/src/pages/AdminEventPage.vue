<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import {
  NButton,
  NDatePicker,
  NInput,
  NInputNumber,
  NPopconfirm,
  NSelect,
  useDialog,
  useMessage,
} from 'naive-ui';
import { ApiError, api, formatDate, STATUS_LABEL, type EventView } from '../lib/api';
import HelpTip from '../components/HelpTip.vue';
import PageBack from '../components/PageBack.vue';
import RankMedal from '../components/RankMedal.vue';
import VerificationFilter from '../components/VerificationFilter.vue';
import VerificationTag from '../components/VerificationTag.vue';
import {
  filterPlayers,
  sortPlayers,
  verificationCounts,
  type PlayerSortKey,
} from '../lib/player-table';
import { mmrHint } from '../lib/rank';
import { SERVER_HELP, SERVER_OPTIONS, type ServerRegion } from '../lib/server';
import { nextSort, type SortState } from '../lib/sort';
import type { VerificationFilter as FilterValue } from '../lib/verification';

interface RegRow {
  id: string;
  userId: string;
  displayName: string;
  username: string;
  role: 'PLAYER' | 'ADMIN';
  status: string;
  position: number | null;
  waitlistPosition: number | null;
  /** 报名时冻结的评分快照（分队用的就是它） */
  effectiveRating: number;
  attendanceBp: number | null;
  /** 段位 / 天梯分 / 来源 / 身份验证：管理员判断"这个人的分可不可信"要看这些 */
  rankTier: number | null;
  declaredMmr: number | null;
  rankSource: string | null;
  verification: string | null;
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

interface LineupMember {
  id: string;
  userId: string;
  displayName: string;
  position: number;
  fitScore: number;
  effectiveRating: number;
}

interface LineupTeam {
  side: string;
  totalRating: number;
  averageRating: number;
  positionCoverageBp: number;
  members: LineupMember[];
}

interface LineupView {
  match: {
    id: string;
    status: string;
    version: number;
    ratingGap: number | null;
    teams: LineupTeam[];
  };
}

const route = useRoute();
const eventId = route.params.id as string;

const event = ref<EventView | null>(null);
const regs = ref<RegRow[]>([]);
const matches = ref<MatchRow[]>([]);
const lineup = ref<LineupView | null>(null);

const loading = ref(true);
const busy = ref(false);
const error = ref('');
const message = ref('');
const toast = useMessage();
const dialog = useDialog();

/** 当前展开的场次（手风琴，一次只开一场）；null = 全部收起 */
const openMatchId = ref<string | null>(null);
const drawerLoading = ref(false);

const seed = ref(0);
const policy = ref<'START_PARTIAL' | 'EXTEND' | 'CANCEL'>('START_PARTIAL');
const matchNo = ref(1);

const policyOptions = [
  { label: '按现有人数开局', value: 'START_PARTIAL' },
  { label: '延长报名 2 小时', value: 'EXTEND' },
  { label: '取消赛事', value: 'CANCEL' },
];

/* ---- 编辑赛事：只有草稿/报名中能改容量与赛程，标题随时可改 ---- */
const editing = ref(false);
/** 时间用毫秒时间戳（NDatePicker 的原生值），null = 未设置 */
const form = ref({
  title: '',
  capacity: 20,
  registrationClosesAt: null as number | null,
  startsAt: null as number | null,
  /** 服务器不属于赛程：归档/取消之外随时可改 */
  serverRegion: 'GLOBAL' as ServerRegion,
});
const scheduleEditable = computed(
  () => event.value?.status === 'DRAFT' || event.value?.status === 'REGISTRATION_OPEN',
);

function openEdit() {
  const current = event.value;
  if (!current) return;
  form.value = {
    title: current.title,
    capacity: current.capacity,
    registrationClosesAt: current.registrationClosesAt,
    startsAt: current.startsAt,
    serverRegion: current.serverRegion,
  };
  editing.value = true;
  message.value = '';
}

function toggleEdit() {
  if (editing.value) {
    editing.value = false;
    return;
  }
  openEdit();
}

const confirmed = computed(() => regs.value.filter((r) => r.status === 'CONFIRMED'));
const waitlist = computed(() => regs.value.filter((r) => r.status === 'WAITLIST'));

/**
 * 已退赛的报名行。数据要保留（重新报名会复用同一行，见 POST /registrations），
 * 但它不在名单里：既不占正选/候补名额，也不该混在表格里当成"还报着名"。
 */
const withdrawn = computed(() => regs.value.filter((r) => r.status === 'WITHDRAWN'));
const canForm = computed(() => Math.floor(confirmed.value.length / 10));
const odd = computed(() => confirmed.value.length % 10 !== 0 && confirmed.value.length >= 10);

const attendanceOf = (reg: RegRow) => {
  const bp = reg.attendanceBp;
  return typeof bp === 'number' ? `${Math.round(bp / 100)}%` : '—';
};

/* ---------------------------------------------------- 报名名单：筛选 / 排序 */

/** 玩家列表的筛选排序要的是 `effective`，报名快照字段叫 effectiveRating */
type RegListView = RegRow & { effective: number };

const regList = computed<RegListView[]>(() =>
  regs.value
    .filter((reg) => reg.status !== 'WITHDRAWN')
    .map((reg) => ({ ...reg, effective: reg.effectiveRating })),
);

/** 报名状态文案：未知值不要把英文枚举直接甩到界面上 */
const REG_STATUS_LABEL: Record<string, string> = {
  CONFIRMED: '正选',
  WAITLIST: '候补',
  WITHDRAWN: '已退赛',
};

function regStatusLabel(reg: RegRow): string {
  if (reg.status === 'WAITLIST') return reg.waitlistPosition ? `候补 ${reg.waitlistPosition}` : '候补';
  return REG_STATUS_LABEL[reg.status] ?? '未知状态';
}

function regStatusClass(status: string): string {
  if (status === 'CONFIRMED') return 'tag-confirmed';
  if (status === 'WAITLIST') return 'tag-waitlist';
  return 'tag-other';
}

/** 默认不排序：保持服务端的「正选按评分 → 候补按顺序」 */
const regFilter = ref<FilterValue>('ALL');
const regSort = ref<SortState<PlayerSortKey> | null>(null);
const regCounts = computed(() => verificationCounts(regList.value));

const regRows = computed<RegListView[]>(() => {
  const filtered = filterPlayers(regList.value, regFilter.value);
  if (!regSort.value) return filtered;
  // 排序只作用于组内：正选永远在候补前面，否则"谁在候补第几位"会看不出来
  const sorted = sortPlayers(filtered, regSort.value);
  const rank = (status: string) => (status === 'CONFIRMED' ? 0 : status === 'WAITLIST' ? 1 : 2);
  return [...sorted].sort((a, b) => rank(a.status) - rank(b.status));
});

function onRegSort(key: PlayerSortKey) {
  regSort.value = regSort.value ? nextSort(regSort.value, key) : { key, direction: 'desc' };
}

const regSortArrow = (key: PlayerSortKey) =>
  regSort.value?.key === key ? (regSort.value.direction === 'desc' ? '▼' : '▲') : '';

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
    toast.success(okMessage);
    await refresh();
    // 展开中的抽屉要跟着刷新：发布 / 流局 / 录入结果都会改它的状态与版本号
    await reloadOpenLineup();
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '操作失败';
    toast.error(error.value);
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

/** 只提交真正改过的字段：没动的时间不会被"清空"，后端也不用猜 */
async function saveEdit() {
  const current = event.value;
  if (!current) return;
  const body: Record<string, unknown> = {};

  const title = form.value.title.trim();
  if (title && title !== current.title) body.title = title;

  if (form.value.serverRegion !== current.serverRegion) {
    body.serverRegion = form.value.serverRegion;
  }

  const capacity = Number(form.value.capacity);
  if (Number.isFinite(capacity) && capacity > 0 && capacity !== current.capacity) {
    body.capacity = capacity;
  }

  if (scheduleEditable.value) {
    // 用毫秒比较：null（清空）与"没动"必须区分开，否则用户永远清不掉一个时间
    if (form.value.registrationClosesAt !== current.registrationClosesAt) {
      body.registrationClosesAt = form.value.registrationClosesAt
        ? new Date(form.value.registrationClosesAt).toISOString()
        : null;
    }
    if (form.value.startsAt !== current.startsAt) {
      body.startsAt = form.value.startsAt ? new Date(form.value.startsAt).toISOString() : null;
    }
  }

  if (Object.keys(body).length === 0) {
    message.value = '没有需要保存的改动';
    return;
  }

  await run(() => api(`/admin/events/${eventId}`, { method: 'PATCH', body }), '赛事信息已更新');
  editing.value = false;
}

const promote = (registrationId: string) =>
  run(
    () =>
      api(`/admin/events/${eventId}/registrations/${registrationId}/promote`, {
        method: 'POST',
        body: {},
      }),
    '候补已转正',
  );

/**
 * 生成阵容：不收起抽屉，直接展开刚生成的那一场。
 * 生成完的下一步必然是"看阵容 / 调人 / 发布"，收起只会让人多点一次「查看阵容」。
 */
async function generate() {
  if (lineupDirty.value) {
    dialog.warning({
      title: '有未保存的阵容调整',
      content: '生成后会自动切到新场次，当前这场的拖拽调整会丢失。确定继续吗？',
      positiveText: '继续生成',
      negativeText: '取消',
      onPositiveClick: () => doGenerate(),
    });
    return;
  }
  await doGenerate();
}

async function doGenerate() {
  busy.value = true;
  error.value = '';
  message.value = '';
  const okText = '阵容已生成（草稿，未发布）';
  try {
    const created = await api<{ matchId: string }>('/admin/matches/generate', {
      method: 'POST',
      body: { eventId, matchNo: matchNo.value, seed: seed.value },
    });
    message.value = okText;
    toast.success(okText);
    await refresh();
    await openLineup(created.matchId);
    // 生成按钮在顶部，抽屉在下面：离得远就滚过去，已经在视野里就不动
    document
      .getElementById(`match-${created.matchId}`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '生成阵容失败';
    toast.error(error.value);
  } finally {
    busy.value = false;
  }
}

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

/**
 * 打开某一场的阵容抽屉。
 * 手风琴：一次只开一场——同一页里同时开两份可拖拽阵容，拖到一半很容易搞混。
 */
async function openLineup(matchId: string) {
  openMatchId.value = matchId;
  lineup.value = null;
  lineupOriginal.value = new Map();
  dragFrom.value = null;
  drawerLoading.value = true;
  error.value = '';
  try {
    applyLineup(await api<LineupView>(`/admin/matches/${matchId}/lineup`));
  } catch (err) {
    openMatchId.value = null;
    error.value = err instanceof ApiError ? err.message : '加载阵容失败';
    toast.error(error.value);
  } finally {
    drawerLoading.value = false;
  }
}

function closeLineup() {
  openMatchId.value = null;
  lineup.value = null;
  lineupOriginal.value = new Map();
  dragFrom.value = null;
}

/** 操作之后重新拉取展开的那场；比赛已经不在列表里就收起抽屉 */
async function reloadOpenLineup() {
  const id = openMatchId.value;
  if (!id) return;
  if (!matches.value.some((match) => match.id === id)) {
    closeLineup();
    return;
  }
  try {
    applyLineup(await api<LineupView>(`/admin/matches/${id}/lineup`));
  } catch {
    closeLineup();
  }
}

/** 点场次行（或「查看阵容」）开合抽屉；有未保存的拖拽调整时先问一句 */
function toggleMatch(matchId: string) {
  if (openMatchId.value === matchId) {
    if (lineupDirty.value) {
      dialog.warning({
        title: '有未保存的阵容调整',
        content: '收起后这场的拖拽调整会丢失，确定收起吗？',
        positiveText: '放弃调整',
        negativeText: '继续调整',
        onPositiveClick: () => closeLineup(),
      });
      return;
    }
    closeLineup();
    return;
  }

  if (lineupDirty.value) {
    dialog.warning({
      title: '有未保存的阵容调整',
      content: '切换场次后当前这场的调整会丢失，确定切换吗？',
      positiveText: '放弃调整',
      negativeText: '留在本场',
      onPositiveClick: () => openLineup(matchId),
    });
    return;
  }
  void openLineup(matchId);
}

/* ---------------------------------------------------------------- 拖拽换人 */
/** 打开时的原始站位，用来算"哪些人真的被挪动了" */
const lineupOriginal = ref(new Map<string, { side: string; position: number }>());
const dragFrom = ref<{ side: string; position: number } | null>(null);
const savingLineup = ref(false);

const editable = computed(() => lineup.value?.match.status === 'DRAFT');

/** 把队伍摊成 5 个固定槽位，空位也要画出来（否则拖过去没地方落） */
function slotsOf(team: LineupTeam) {
  const byPosition = new Map(team.members.map((member) => [member.position, member]));
  return [1, 2, 3, 4, 5].map((position) => ({
    position,
    member: byPosition.get(position) ?? null,
  }));
}

const teamTotal = (team: LineupTeam) =>
  team.members.reduce((sum, member) => sum + member.effectiveRating, 0);

/** 拖拽后服务端的 totalRating 是旧的，这里按当前站位实时算 */
const liveGap = computed(() => {
  const teams = lineup.value?.match.teams ?? [];
  if (teams.length !== 2) return null;
  return Math.abs(teamTotal(teams[0] as LineupTeam) - teamTotal(teams[1] as LineupTeam));
});

function onDragStart(side: string, position: number) {
  if (!editable.value) return;
  dragFrom.value = { side, position };
}

/** 落子：同队内交换位置，跨队则两人互换（对齐 + 位置一起换） */
function onDrop(side: string, position: number) {
  const from = dragFrom.value;
  dragFrom.value = null;
  const view = lineup.value;
  if (!from || !view || !editable.value) return;
  if (from.side === side && from.position === position) return;

  const fromTeam = view.match.teams.find((team) => team.side === from.side);
  const toTeam = view.match.teams.find((team) => team.side === side);
  if (!fromTeam || !toTeam) return;

  const moving = fromTeam.members.find((member) => member.position === from.position);
  if (!moving) return;
  const target = toTeam.members.find((member) => member.position === position) ?? null;

  fromTeam.members = fromTeam.members.filter((member) => member.id !== moving.id);
  if (target) {
    toTeam.members = toTeam.members.filter((member) => member.id !== target.id);
    fromTeam.members.push(target);
    target.position = from.position;
  }
  toTeam.members.push(moving);
  moving.position = position;
}

const lineupDirty = computed(() => {
  const view = lineup.value;
  if (!view) return false;
  for (const team of view.match.teams) {
    for (const member of team.members) {
      const before = lineupOriginal.value.get(member.id);
      if (!before || before.side !== team.side || before.position !== member.position) return true;
    }
  }
  return false;
});

async function saveLineup() {
  const view = lineup.value;
  if (!view) return;

  // 整份提交：只发真的动过的人
  const moves = view.match.teams.flatMap((team) =>
    team.members
      .filter((member) => {
        const before = lineupOriginal.value.get(member.id);
        return !before || before.side !== team.side || before.position !== member.position;
      })
      .map((member) => ({
        teamMemberId: member.id,
        toSide: team.side,
        toPosition: member.position,
      })),
  );

  if (moves.length === 0) {
    toast.info('没有改动');
    return;
  }

  savingLineup.value = true;
  try {
    const updated = await api<LineupView>(`/admin/matches/${view.match.id}/lineup`, {
      method: 'PATCH',
      body: { version: view.match.version, moves },
    });
    applyLineup(updated);
    // 上方"场次"列表里的 version / 分差也要跟着变，否则两处显示对不上
    const row = matches.value.find((item) => item.id === updated.match.id);
    if (row) {
      row.version = updated.match.version;
      row.ratingGap = updated.match.ratingGap;
    }
    toast.success('阵容已更新');
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '保存阵容失败';
    toast.error(error.value);
  } finally {
    savingLineup.value = false;
  }
}

function applyLineup(view: LineupView) {
  lineup.value = view;
  const map = new Map<string, { side: string; position: number }>();
  for (const team of view.match.teams) {
    for (const member of team.members) {
      map.set(member.id, { side: team.side, position: member.position });
    }
  }
  lineupOriginal.value = map;
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
    <PageBack label="返回后台" />

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
          <NButton
            v-if="event.status === 'DRAFT'"
            type="primary"
            :disabled="busy"
            @click="transition('REGISTRATION_OPEN')"
          >
            开放报名
          </NButton>
          <NButton
            v-if="event.status === 'REGISTRATION_OPEN'"
            :disabled="busy"
            @click="transition('REGISTRATION_CLOSED')"
          >
            关闭报名
          </NButton>

          <template v-if="event.status === 'REGISTRATION_CLOSED'">
            <NSelect
              v-model:value="policy"
              :options="policyOptions"
              style="width: 190px"
              size="medium"
            />
            <NButton type="primary" :disabled="busy" @click="finalize">封盘结算</NButton>
          </template>

          <template v-if="event.status === 'REGISTRATION_CLOSED' || event.status === 'PUBLISHED'">
            <span class="muted" style="font-size: 12px">第</span>
            <NInputNumber v-model:value="matchNo" :min="1" :max="10" :show-button="false" style="width: 70px" />
            <span class="muted" style="font-size: 12px">场 · seed</span>
            <NInputNumber v-model:value="seed" :min="0" :show-button="false" style="width: 92px" />
            <NButton :disabled="busy" @click="generate">生成阵容</NButton>
          </template>

          <NButton :disabled="busy" @click="toggleEdit">
            {{ editing ? '收起编辑' : '编辑' }}
          </NButton>
          <NButton :disabled="busy" @click="refresh">刷新</NButton>
        </div>

        <!-- 编辑面板：容量与赛程只在草稿/报名中可改 -->
        <div v-if="editing" class="card" style="margin-top: 14px; padding: 14px">
          <div class="event-edit">
            <label class="field">
              <span class="field-label">标题</span>
              <NInput v-model:value="form.title" :maxlength="64" style="width: 220px" size="medium" />
            </label>
            <label class="field">
              <span class="field-label">
                服务器
                <HelpTip v-bind="SERVER_HELP" />
              </span>
              <NSelect
                v-model:value="form.serverRegion"
                :options="SERVER_OPTIONS"
                style="width: 220px"
                size="medium"
              />
            </label>
            <label class="field">
              <span class="field-label">
                目标人数
                <HelpTip
                  title="目标人数怎么填？"
                  :steps="[
                    '① 必须是 10 的整数倍（20 = 2 场 × 10 人）',
                    '② 它是目标人数，不是座位数；报名期不生成比赛',
                    '③ 不能低于已确认人数',
                  ]"
                  note="封盘时按 floor(已确认 / 10) 切场，余下的人进候补；人数卡在两档之间时要显式选开局策略。"
                />
              </span>
              <NInputNumber
                v-model:value="form.capacity"
                :min="10"
                :max="100"
                :step="10"
                :show-button="false"
                style="width: 96px"
                size="medium"
              />
            </label>
            <label class="field field-date">
              <span class="field-label">报名截止</span>
              <NDatePicker
                v-model:value="form.registrationClosesAt"
                type="datetime"
                clearable
                :disabled="!scheduleEditable"
                format="yyyy-MM-dd HH:mm"
                time-picker-format="HH:mm"
                style="width: 100%"
                size="medium"
              />
            </label>
            <label class="field field-date">
              <span class="field-label">开赛</span>
              <NDatePicker
                v-model:value="form.startsAt"
                type="datetime"
                clearable
                :disabled="!scheduleEditable"
                format="yyyy-MM-dd HH:mm"
                time-picker-format="HH:mm"
                style="width: 100%"
                size="medium"
              />
            </label>
            <NButton type="primary" :disabled="busy" @click="saveEdit">保存</NButton>
          </div>
          <p v-if="!scheduleEditable" class="coverage-warn" style="font-size: 12px; margin-top: 8px">
            报名已关闭：容量与赛程已参与封盘决策，只能改标题与服务器。
          </p>
        </div>

        <p v-if="odd" class="coverage-warn" style="margin-top: 12px">
          {{ confirmed.length }} 人只能开 {{ canForm }} 场，余 {{ confirmed.length - canForm * 10 }} 人需要进候补。
          封盘时请选「按现有人数开局」或「延长报名」。
        </p>        <p v-if="error" class="alert" style="margin-top: 12px">{{ error }}</p>
        <p v-if="message" class="muted" style="margin-top: 12px">{{ message }}</p>
      </section>

      <!-- 场次：一场一卡，阵容抽屉长在对应场次里 —— 多场时每场的状态一眼可见 -->
      <section class="section">
        <div class="section-head">
          <h2 class="section-title">场次</h2>
          <span v-if="matches.length" class="muted" style="font-size: 12px">
            共 {{ matches.length }} 场 · 点场次展开阵容
          </span>
        </div>

        <div v-if="matches.length === 0" class="empty">还没有生成阵容。</div>
        <div v-else class="match-list">
          <article
            v-for="match in matches"
            :key="match.id"
            :id="`match-${match.id}`"
            class="match-item"
            :class="{ 'is-open': openMatchId === match.id }"
          >
            <div class="match-row">
              <button
                type="button"
                class="match-toggle"
                :aria-expanded="openMatchId === match.id"
                @click="toggleMatch(match.id)"
              >
                <svg class="match-chevron" viewBox="0 0 16 16" aria-hidden="true">
                  <path
                    d="M6 3.5 10.5 8 6 12.5"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.7"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
                <span class="mono match-no">第 {{ match.matchNo }} 场</span>
                <span :class="statusPill(match.status)">
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
                <span class="muted match-meta">
                  {{ match.memberCount }} 人 · 分差 {{ match.ratingGap ?? '—' }} · v{{ match.version }}
                </span>
                <span v-if="match.status === 'COMPLETED'" class="mono match-result">
                  {{ match.radiantWin ? 'Radiant 胜' : 'Dire 胜' }}
                  <template v-if="match.durationSeconds">
                    · {{ formatDuration(match.durationSeconds) }}
                  </template>
                </span>
              </button>

              <div class="match-actions" @click.stop>
                <template v-if="match.status === 'PUBLISHED' || match.status === 'IN_PROGRESS'">
                  <NInputNumber
                    v-model:value="durations[match.id]"
                    :min="300"
                    :max="14400"
                    :show-button="false"
                    placeholder="时长(秒)"
                    style="width: 118px"
                    size="small"
                  />
                  <NButton quaternary :disabled="busy" @click="record(match.id, true)">
                    Radiant 胜
                  </NButton>
                  <NButton quaternary :disabled="busy" @click="record(match.id, false)">
                    Dire 胜
                  </NButton>
                  <NPopconfirm @positive-click="voidMatch(match.id)">
                    <template #trigger>
                      <NButton quaternary :disabled="busy">流局</NButton>
                    </template>
                    流局会保留数据但让这场不计入战绩，确定吗？
                  </NPopconfirm>
                </template>
                <NButton quaternary :disabled="busy" @click="toggleMatch(match.id)">
                  {{ openMatchId === match.id ? '收起阵容' : '查看阵容' }}
                </NButton>
                <NButton
                  v-if="match.status === 'DRAFT'"
                  type="primary"
                  :disabled="busy"
                  @click="publish(match.id)"
                >
                  发布
                </NButton>
              </div>
            </div>

            <!-- 抽屉：懒加载，点开才请求这一场的阵容 -->
            <div v-if="openMatchId === match.id" :id="`lineup-${match.id}`" class="match-drawer">
              <div v-if="drawerLoading" class="drawer-loading">加载阵容…</div>
              <template v-else-if="lineup">
                <div class="drawer-head">
                  <div class="drawer-title">
                    阵容
                    <HelpTip
                      v-if="editable"
                      title="怎么调整阵容？"
                      :steps="[
                        '① 把任意玩家拖到另一个格子即可换位',
                        '② 跨队拖动会交换两人的位置',
                        '③ 契合度低于 40 的会标黄',
                      ]"
                      note="保存后版本号 +1（场次行上能看到）；调整只改这一场的分组，不动评分。"
                    />
                  </div>
                  <div class="drawer-tools">
                    <span class="muted" style="font-size: 12px">
                      分差 <span class="mono">{{ liveGap ?? '—' }}</span> · v{{ lineup.match.version }}
                    </span>
                    <NButton
                      v-if="editable"
                      type="primary"
                      :disabled="savingLineup || !lineupDirty"
                      :loading="savingLineup"
                      @click="saveLineup"
                    >
                      保存调整
                    </NButton>
                    <NButton v-else :disabled="busy" @click="reloadOpenLineup">刷新</NButton>
                  </div>
                </div>

                <p
                  v-if="editable && lineupDirty"
                  class="coverage-warn"
                  style="font-size: 12px; margin: 0 0 10px"
                >
                  有未保存的调整。
                </p>

                <div class="match-board">
                  <div
                    v-for="team in lineup.match.teams"
                    :key="team.side"
                    class="team"
                    :class="team.side === 'RADIANT' ? 'team-radiant' : 'team-dire'"
                  >
                    <div class="team-name">
                      <span>{{ team.side }}</span>
                      <span class="mono">{{ teamTotal(team) }}</span>
                    </div>
                    <div
                      v-for="slot in slotsOf(team)"
                      :key="slot.position"
                      class="slot"
                      :class="{
                        'slot-empty': !slot.member,
                        'slot-draggable': editable && !!slot.member,
                        'slot-dragover':
                          dragFrom &&
                          !(dragFrom.side === team.side && dragFrom.position === slot.position),
                      }"
                      :draggable="editable && !!slot.member"
                      @dragstart="onDragStart(team.side, slot.position)"
                      @dragover.prevent
                      @drop.prevent="onDrop(team.side, slot.position)"
                    >
                      <span class="slot-pos">{{ slot.position }} 号位</span>
                      <template v-if="slot.member">
                        <span class="slot-name">{{ slot.member.displayName }}</span>
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
              </template>
            </div>
          </article>
        </div>
      </section>

      <!-- 报名名单 -->
      <section class="section">
        <div class="section-head">
          <h2 class="section-title">报名名单</h2>
          <span class="muted" style="font-size: 13px">
            {{ confirmed.length }} 正选 / {{ waitlist.length }} 候补
            <template v-if="withdrawn.length > 0">
              ·
              <span :title="`已退赛：${withdrawn.map((r) => r.displayName).join('、')}`">
                {{ withdrawn.length }} 人已退赛
              </span>
            </template>
          </span>
        </div>

        <div v-if="regList.length === 0" class="empty">
          <template v-if="withdrawn.length > 0">
            报名者都已退赛：{{ withdrawn.map((r) => r.displayName).join('、') }}
          </template>
          <template v-else>还没有人报名。</template>
        </div>

        <template v-else>
          <div class="list-tools">
            <VerificationFilter v-model="regFilter" :counts="regCounts" />
            <span class="muted list-tools-hint">点表头按段位 / MMR / 评分排序，排序只在正选、候补内部生效</span>
          </div>

          <div v-if="regRows.length === 0" class="empty">这个筛选下没有报名者。</div>

          <div v-else class="card" style="padding: 8px 12px">
            <p class="muted" style="font-size: 12px; margin: 4px 4px 10px">
              候补顺序：出勤率 → 评分 → 报名时间；出勤低的人会排在后面。
            </p>
            <div class="table-wrap">
              <table class="table">
                <thead>
                  <tr>
                    <th>昵称</th>
                    <th>用户名</th>
                    <th title="身份由谁证明：Steam / 数字 ID / 自报">验证</th>
                    <th>角色</th>
                    <th>状态</th>
                    <th class="th-sort" @click="onRegSort('rankTier')">
                      段位 <span class="sort-arrow">{{ regSortArrow('rankTier') }}</span>
                    </th>
                    <th class="num th-sort" @click="onRegSort('mmr')">
                      MMR <span class="sort-arrow">{{ regSortArrow('mmr') }}</span>
                    </th>
                    <th
                      class="num th-sort"
                      title="报名时冻结的评分快照——分队用的就是它，之后改评分不会回写"
                      @click="onRegSort('effective')"
                    >
                      评分 <span class="sort-arrow">{{ regSortArrow('effective') }}</span>
                    </th>
                    <th class="num">出勤</th>
                    <th>位置</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="reg in regRows" :key="reg.id">
                    <td>{{ reg.displayName }}</td>
                    <td class="mono muted" style="font-size: 12px">@{{ reg.username }}</td>
                    <td><VerificationTag :verification="reg.verification" /></td>
                    <td>
                      <span v-if="reg.role === 'ADMIN'" class="tag tag-other">管理员</span>
                      <span v-else class="muted" style="font-size: 12px">玩家</span>
                    </td>
                    <td>
                      <span class="tag" :class="regStatusClass(reg.status)">
                        {{ regStatusLabel(reg) }}
                      </span>
                    </td>
                    <td><RankMedal :rank-tier="reg.rankTier" /></td>
                    <td
                      class="num mono"
                      :title="mmrHint(reg.declaredMmr, reg.rankTier, reg.rankSource)"
                    >
                      <span :class="{ muted: reg.declaredMmr === null }">
                        {{ reg.declaredMmr === null ? '—' : reg.declaredMmr.toLocaleString('en-US') }}
                      </span>
                    </td>
                    <td class="num mono" style="color: var(--gold-2)">
                      {{ reg.effectiveRating }}
                    </td>
                    <td class="num mono muted">{{ attendanceOf(reg) }}</td>
                    <td class="muted">{{ reg.position ? `${reg.position} 号位` : '未填' }}</td>
                    <td>
                      <NButton
                        v-if="reg.status === 'WAITLIST'"
                        quaternary
                        size="small"
                        :disabled="busy"
                        @click="promote(reg.id)"
                      >
                        转正
                      </NButton>
                    </td>
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
