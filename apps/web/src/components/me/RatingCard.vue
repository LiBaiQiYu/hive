<script setup lang="ts">
/**
 * WARROOM 评分卡（我的主页）。
 *
 * 总分、构成、置信度都来自全局 session 里的 /api/me，这里只额外拉一次
 * 管理员修正记录——那是低频数据，没必要跟着主档案一起返回；拉不到就整段隐藏，
 * 不能因为一条附注把整张档案卡打成空白。
 */
import { computed, onMounted, ref } from 'vue';
import HelpTip from '../HelpTip.vue';
import { api, formatDate } from '../../lib/api';
import { session } from '../../lib/session';

interface RatingHistoryRow {
  id: string;
  oldAdjustment: number;
  newAdjustment: number;
  oldEffective: number;
  newEffective: number;
  reason: string;
  createdAt: number;
  operatorName: string | null;
}

const rating = computed(() => session.me?.rating ?? null);
const ratingHistory = ref<RatingHistoryRow[]>([]);

/** 出勤是独立指标：无记录时按中性 50% 展示，和候补排序口径一致 */
const attendancePct = computed(() => {
  const bp = rating.value?.breakdown?.attendanceBp;
  return typeof bp === 'number' ? Math.round(bp / 100) : null;
});
const attendanceWidth = computed(() => attendancePct.value ?? 50);
const attendanceCounts = computed(() => {
  const breakdown = rating.value?.breakdown;
  const played = breakdown?.attendancePlayed;
  const registered = breakdown?.attendanceRegistered;
  if (typeof played !== 'number' || typeof registered !== 'number') return null;
  return `${played}/${registered}`;
});
const staleAlgorithm = computed(
  () => rating.value !== null && rating.value.algorithmVersion !== 'warroom-v3',
);

const componentLabel = (key: string) => {
  if (key === 'MMR') return '天梯实力';
  if (key === 'RANK') return '段位（旧）';
  if (key === 'FORM') return '近期表现（旧）';
  if (key === 'POSITION') return '位置（旧）';
  if (key === 'HERO_POOL') return '英雄池（旧）';
  if (key === 'COMMUNITY') return '出勤（旧）';
  return key;
};

const basisLabel = (basis: string) => {
  if (basis === 'SELF_MMR') return '自报 MMR';
  if (basis === 'MEDAL') return '勋章估算';
  if (basis === 'MMR') return '勋章估算（旧）';
  if (basis === 'NO_DATA') return '无段位数据';
  return basis;
};

async function loadRatingHistory() {
  try {
    const data = await api<{ history: RatingHistoryRow[] }>('/me/rating-history');
    ratingHistory.value = data.history;
  } catch {
    ratingHistory.value = [];
  }
}

const signed = (n: number) => `${n >= 0 ? '+' : ''}${n}`;

onMounted(() => {
  void loadRatingHistory();
});
</script>

<template>
  <section class="card">
    <h2 class="card-title">
      WARROOM Rating
      <HelpTip
        wide
        title="这个分怎么算的？"
        :steps="[
          '① 实力分 = 天梯 MMR ÷ 10，范围 0–1000；没有段位/MMR 时给 500 中性值',
          '② 出勤单独计算，不进入实力分——技术好但少来，不会因此被算成低分',
          '③ 出勤只影响候补优先级：出勤率 → 实力分 → 报名时间',
          '④ 分队只看实力分，不看谁更勤快；管理员修正仍然独立计算',
        ]"
        note="报名与分队时会冻结当时的评分快照，之后调整不影响已公布的阵容。管理员修正必须填原因、不可删除，幅度随数据可信度放宽到 ±500。"
      />
    </h2>

    <template v-if="rating">
      <div class="rating-hero">
        <div class="rating-score mono">{{ rating.effective }}</div>
        <div class="rating-pm mono">± {{ rating.uncertainty }}</div>
      </div>

      <div class="rating-split">
        <div>
          <div class="stat-label">实力分（MMR）</div>
          <div class="mono">{{ rating.system }}</div>
        </div>
        <div>
          <div class="stat-label">管理员修正</div>
          <div class="mono">
            {{ rating.adjustment >= 0 ? '+' : '' }}{{ rating.adjustment }}
          </div>
        </div>
        <div>
          <div class="stat-label">数据置信度</div>
          <div class="mono">{{ (rating.confidenceBp / 100).toFixed(0) }}%</div>
        </div>
      </div>

      <!-- 实力分：v3 只有 MMR 一项；旧数据仍可能带 RANK/COMMUNITY -->
      <div v-if="rating.breakdown" class="rating-break">
        <div class="rating-break-title">实力分构成</div>
        <div
          v-for="part in rating.breakdown.components"
          :key="part.key"
          class="rating-break-row"
        >
          <span class="rating-break-name">{{ componentLabel(part.key) }}</span>
          <div class="rating-break-bar">
            <i :style="{ width: `${Math.round(part.value * 100)}%` }"></i>
          </div>
          <span class="rating-break-score mono">
            {{ part.score }}<span class="muted"> / {{ part.weight }}</span>
          </span>
        </div>
        <p class="rating-break-note muted">
          <template v-if="typeof rating.breakdown.estimatedMmr === 'number'">
            估算 MMR {{ rating.breakdown.estimatedMmr }} · 实力分 = MMR ÷ 10 ·
            {{ basisLabel(rating.breakdown.components[0]?.basis ?? '') }}
          </template>
          <template v-else>没有段位 / MMR，按 500 中性值计算</template>
        </p>
      </div>

      <!-- 出勤独立：不进入实力分，只决定候补顺序 -->
      <div v-if="rating.breakdown" class="rating-break rating-attendance">
        <div class="rating-break-title">出勤（只影响候补）</div>
        <div class="rating-break-row">
          <span class="rating-break-name">出勤率</span>
          <div class="rating-break-bar">
            <i :style="{ width: `${attendanceWidth}%` }"></i>
          </div>
          <span class="rating-break-score mono">
            {{ attendancePct === null ? '无记录' : `${attendancePct}%` }}
          </span>
        </div>
        <p class="rating-break-note muted">
          <template v-if="attendancePct === null">
            还没有已结束的赛事；候补排序按 50% 中性值。
          </template>
          <template v-else>
            <template v-if="attendanceCounts">实际出场 {{ attendanceCounts }} 场 · </template>
            候补顺序：出勤率 → 实力分 → 报名时间。
          </template>
          出勤不进入实力分，也不影响分队。
        </p>
      </div>

      <p v-if="staleAlgorithm" class="rating-break-note muted">
        这条评分还是旧算法；管理员在「后台 → 评分管理」点一次「重算全部」后会按 MMR 更新。
      </p>

      <details v-if="ratingHistory.length > 0" class="explainer">
        <summary>评分调整记录（{{ ratingHistory.length }}）</summary>
        <div class="explainer-body">
          <div v-for="item in ratingHistory" :key="item.id" class="rating-history-row">
            <span class="muted">{{ formatDate(item.createdAt) }}</span>
            <span class="mono">
              {{ signed(item.oldAdjustment) }} → {{ signed(item.newAdjustment) }}
            </span>
            <span class="mono">最终 {{ item.newEffective }}</span>
            <span class="muted">{{ item.operatorName ?? '—' }}</span>
            <span class="rating-history-reason">{{ item.reason }}</span>
          </div>
        </div>
      </details>
    </template>

    <p v-else class="muted" style="margin: 0">
      还没有评分记录。绑定 Steam 或填写段位后，管理员可以为你设定初始评分。
    </p>
  </section>
</template>
