<script setup lang="ts">
/**
 * 赛事卡（首页「当前赛事 / 近期赛事」与赛事列表共用）。
 *
 * 一张赛事卡最先要回答两个问题：**什么时候截止报名**、**什么时候开打**。
 * 原来只有一行 12px 的灰字写了截止时间，开赛时间根本没显示。
 * 现在把它们拎出来并排成「时间条」：
 *   · 报名还开着 → 截止时间是主信息（金色 + 倒计时，不足 24 小时转琥珀色）
 *   · 封盘之后   → 主角换成开赛时间（截止那格自动降级）
 * 缺哪个时间就不显示哪一格，卡片不会出现"待定 · 待定"这种占位。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import HelpTip from './HelpTip.vue';
import { formatDate, STATUS_LABEL, type EventView } from '../lib/api';
import { SERVER_HELP, serverLabel } from '../lib/server';

const props = defineProps<{ event: EventView }>();

const pillClass = (status: string) => {
  if (status === 'REGISTRATION_OPEN') return 'pill pill-open';
  if (status === 'REGISTRATION_CLOSED') return 'pill pill-closed';
  if (status === 'PUBLISHED') return 'pill pill-published';
  return 'pill pill-idle';
};

/* ---------------------------------------------------------------- 时间条 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const now = ref(Date.now());
let ticker: number | undefined;

// 30 秒一跳足够：「还剩 3 小时」这种粒度不需要每秒唤醒一次渲染
onMounted(() => {
  ticker = window.setInterval(() => {
    now.value = Date.now();
  }, 30_000);
});
onBeforeUnmount(() => window.clearInterval(ticker));

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 报名倒计时：分钟 / 小时 / 天三档，过期说"已截止" */
function deadlineHint(ms: number): string {
  const diff = ms - now.value;
  if (diff <= 0) return '已截止';
  const minutes = Math.floor(diff / MINUTE);
  if (minutes < 60) return `还剩 ${Math.max(minutes, 1)} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `还剩 ${hours} 小时`;
  return `还剩 ${Math.floor(hours / 24)} 天`;
}

/** 开赛日的相对说法：今天 / 明天 / 周六 */
function dayHint(ms: number): string {
  if (ms <= now.value) return '已开赛';
  const target = new Date(ms);
  const today = new Date(now.value);
  const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((startOfDay(target) - startOfDay(today)) / DAY);
  if (days === 0) return '今天';
  if (days === 1) return '明天';
  return WEEKDAYS[target.getDay()] ?? '';
}

interface WhenCell {
  key: 'close' | 'start';
  label: string;
  value: string;
  hint: string;
  /** key = 当前最该看的那一格，passed = 已经过去 */
  tone: 'key' | 'normal' | 'passed';
  /** 不足 24 小时：提示文字转琥珀色 */
  urgent: boolean;
}

/** 这些状态下时间对玩家有意义；已结束/已取消的赛事不再补「待定」占位 */
const ACTIVE_STATUSES = new Set(['REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'PUBLISHED']);

const whenCells = computed<WhenCell[]>(() => {
  const { status, registrationClosesAt, startsAt } = props.event;
  const active = ACTIVE_STATUSES.has(status);
  const cells: WhenCell[] = [];

  if (registrationClosesAt) {
    const diff = registrationClosesAt - now.value;
    const passed = diff <= 0;
    cells.push({
      key: 'close',
      label: '报名截止',
      value: formatDate(registrationClosesAt),
      hint: deadlineHint(registrationClosesAt),
      tone: passed ? 'passed' : status === 'REGISTRATION_OPEN' ? 'key' : 'normal',
      urgent: !passed && diff < DAY,
    });
  } else if (active) {
    // 没填截止时间不是"没有截止"，而是管理员手动封盘：写清楚，别让卡片看起来像漏了数据
    cells.push({
      key: 'close',
      label: '报名截止',
      value: '待定',
      hint: '由管理员手动封盘',
      tone: 'normal',
      urgent: false,
    });
  }

  if (startsAt) {
    const passed = startsAt <= now.value;
    cells.push({
      key: 'start',
      label: '开赛',
      value: formatDate(startsAt),
      hint: dayHint(startsAt),
      // 封盘之后，下一个里程碑就是开赛；报名期它只是次要信息
      tone: passed ? 'passed' : status === 'REGISTRATION_OPEN' ? 'normal' : 'key',
      urgent: false,
    });
  } else if (active) {
    cells.push({
      key: 'start',
      label: '开赛',
      value: '待定',
      hint: '时间还没定',
      tone: 'normal',
      urgent: false,
    });
  }

  return cells;
});
</script>

<template>
  <article class="card event-card">
    <div class="event-head">
      <div class="event-title-row">
        <h3 class="event-name">{{ props.event.title }}</h3>
        <!-- 国服 / 全球服：进错服连房间都进不去，所以放在标题旁边而不是塞进灰色小字 -->
        <span class="server-tag" :class="{ 'is-cn': props.event.serverRegion === 'CN' }">
          {{ serverLabel(props.event.serverRegion) }}
        </span>
        <HelpTip v-bind="SERVER_HELP" />
      </div>
      <span :class="pillClass(props.event.status)">
        {{ STATUS_LABEL[props.event.status] ?? props.event.status }}
      </span>
    </div>

    <div class="event-meta">
      <span>5v5 · DOTA2 · {{ props.event.capacity }} 人（{{ props.event.targetMatches }} 场）</span>
    </div>

    <div
      v-if="whenCells.length > 0"
      class="event-when"
      :style="{ gridTemplateColumns: `repeat(${whenCells.length}, minmax(0, 1fr))` }"
    >
      <div
        v-for="cell in whenCells"
        :key="cell.key"
        class="event-when-cell"
        :class="[`is-${cell.tone}`, { 'is-urgent': cell.urgent }]"
      >
        <span class="event-when-label">{{ cell.label }}</span>
        <span class="event-when-value">{{ cell.value }}</span>
        <span class="event-when-hint">{{ cell.hint }}</span>
      </div>
    </div>

    <div class="progress">
      <div
        class="progress-bar"
        :style="{ width: `${Math.min(100, (props.event.confirmed / props.event.capacity) * 100)}%` }"
      />
    </div>

    <div class="event-foot">
      <div>
        <span class="slots">{{ props.event.confirmed }} / {{ props.event.capacity }}</span>
        <span v-if="props.event.slotsToNextMatch !== null" class="muted" style="margin-left: 10px">
          再需 {{ props.event.slotsToNextMatch }} 人开下一场
        </span>
        <span v-else class="muted" style="margin-left: 10px">已满员</span>
      </div>
      <RouterLink :to="`/events/${props.event.id}`" class="btn">查看详情</RouterLink>
    </div>
  </article>
</template>
