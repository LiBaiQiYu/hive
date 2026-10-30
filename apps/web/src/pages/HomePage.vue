<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import EventCard from '../components/EventCard.vue';
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
</script>

<template>
  <div class="container">
    <section class="hero">
      <p class="hero-kicker">Dota2 Community Warroom</p>
      <h1 class="hero-title">HIVE</h1>
      <p class="hero-sub">
        你的社区，你的内战。系统自动分队，管理员拖动微调；实力评分公开可解释，
        每场比赛的结果都会回到你的档案里。
      </p>
      <div class="hero-actions">
        <RouterLink to="/events" class="btn btn-primary">查看赛事</RouterLink>
        <RouterLink v-if="!session.me" to="/login" class="btn">加入 HIVE</RouterLink>
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
          <span class="help" tabindex="0" aria-label="怎么参加">
            ?
            <span class="help-pop" role="tooltip">
              <b>怎么参加</b>
              <span class="help-step">① 用社区邀请码注册账号</span>
              <span class="help-step">② 在赛事页报名，顺手选一个主位置</span>
              <span class="help-step">③ 满 10 人成一场，系统自动分队；管理员发布后即可查看阵容</span>
              <span class="help-note">
                不足 10 人或人数不是 10 的整数倍时，余下的人进入候补，不会出现缺人的比赛。
              </span>
            </span>
          </span>
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
