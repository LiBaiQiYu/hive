<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import EventCard from '../components/EventCard.vue';
import HelpTip from '../components/HelpTip.vue';
import { api, type EventView } from '../lib/api';
import { session } from '../lib/session';

const events = ref<EventView[]>([]);
const loading = ref(true);

onMounted(async () => {
  try {
    events.value = await api<EventView[]>('/events');
  } catch {
    events.value = [];
  } finally {
    loading.value = false;
  }
});

const openEvent = computed(
  () => events.value.find((e) => e.status === 'REGISTRATION_OPEN') ?? events.value[0] ?? null,
);
const recent = computed(() => events.value.slice(0, 3));
const totalConfirmed = computed(() =>
  events.value.reduce((sum, event) => sum + event.confirmed, 0),
);

/**
 * 首屏状态标签：文案跟随当前赛事状态，没有比赛时不会谎称"进行中"。
 */
const boardBanner = computed(() => {
  const status = openEvent.value?.status;
  if (status === 'PUBLISHED') return '5V5 · 内战进行中';
  if (status === 'REGISTRATION_OPEN') return '5V5 · 报名进行中';
  return '5V5 · 社区内战';
});
</script>

<template>
  <div class="container">
    <!-- 首屏：地图原画 + 对战牌。原画：Dota 2 Gamepedia 地图概念图，仅作社区展示 -->
    <section class="hero hero--warroom">
      <div class="war-art" aria-hidden="true"></div>
      <div class="war-veil" aria-hidden="true"></div>

      <div class="war-copy">
        <p class="hero-kicker">Dota2 Community Warroom</p>
        <h1 class="hero-title">HIVE</h1>
        <p class="hero-sub">
          你的社区，你的内战。系统自动分队，管理员拖动微调；实力评分公开可解释，
          每场比赛的结果都会回到你的档案里。
        </p>
        <div class="hero-actions">
          <RouterLink to="/events" class="btn btn-primary war-cta">
            查看赛事
            <svg class="war-cta-arrow" viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M3 8h9.4M9 4.4 12.6 8 9 11.6"
                fill="none"
                stroke="currentColor"
                stroke-width="1.7"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </RouterLink>
          <RouterLink v-if="!session.me" to="/login" class="btn war-cta-ghost">
            加入 HIVE
          </RouterLink>
        </div>
      </div>

      <div class="war-caption">
        <span class="war-caption-line"></span>
        <span class="war-caption-text">{{ boardBanner }}</span>
        <span class="war-caption-line"></span>
      </div>
    </section>

    <section class="section">
      <div class="stat-row">
        <div class="stat">
          <div class="stat-label">赛事</div>
          <div class="stat-value">{{ events.length }}</div>
        </div>
        <div class="stat">
          <div class="stat-label">累计报名</div>
          <div class="stat-value">{{ totalConfirmed }}</div>
        </div>
        <div class="stat">
          <div class="stat-label">进行中</div>
          <div class="stat-value">
            {{ events.filter((e) => e.status === 'REGISTRATION_OPEN').length }}
          </div>
        </div>
        <div class="stat">
          <div class="stat-label">目标场次</div>
          <div class="stat-value">
            {{ events.reduce((sum, e) => sum + e.targetMatches, 0) }}
          </div>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="section-head">
        <h2 class="section-title">
          当前赛事
          <HelpTip
            title="怎么参加"
            :steps="[
              '① 用社区邀请码注册账号',
              '② 在赛事页报名，顺手选一个主位置',
              '③ 满 10 人成一场，系统自动分队；管理员发布后即可查看阵容',
            ]"
            note="不足 10 人或人数不是 10 的整数倍时，余下的人进入候补，不会出现缺人的比赛。"
          />
        </h2>
        <RouterLink to="/events" class="muted" style="font-size: 13px">全部赛事 →</RouterLink>
      </div>

      <div v-if="loading" class="empty">加载中…</div>
      <div v-else-if="openEvent" class="grid grid-3">
        <EventCard :event="openEvent" />
      </div>
      <div v-else class="empty">还没有赛事。管理员创建后，这里会显示正在报名的那一场。</div>
    </section>

    <section v-if="recent.length > 1" class="section">
      <div class="section-head">
        <h2 class="section-title">近期赛事</h2>
      </div>
      <div class="grid grid-3">
        <EventCard v-for="event in recent" :key="event.id" :event="event" />
      </div>
    </section>
  </div>
</template>
