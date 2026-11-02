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
          '① 范围 0–1000，是分队用的内部值，和天梯 MMR 不是一回事',
          '② 段位 900：天梯勋章与 MMR，几乎决定全部实力判断',
          '③ 社区出勤 100：报名后是否到场，报了不来按缺席比例扣分',
          '④ 样本不足时向 500 收缩，新人不会因为两三局连胜就虚高',
        ]"
        note="战绩、英雄池、位置能力都不进评分（位置属于分队逻辑）。管理员可修正，必须填原因且不可删除，幅度随数据可信度放宽到 ±500。报名与分组时冻结快照，改评分不影响已公布的阵容。"
      />
    </h2>

    <template v-if="rating">
      <div class="rating-hero">
        <div class="rating-score mono">{{ rating.effective }}</div>
        <div class="rating-pm mono">± {{ rating.uncertainty }}</div>
      </div>

      <div class="rating-split">
        <div>
          <div class="stat-label">系统评分</div>
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

      <!-- 评分构成：段位与出勤各贡献多少分 -->
      <div v-if="rating.breakdown" class="rating-break">
        <div class="rating-break-title">系统分构成</div>
        <div
          v-for="part in rating.breakdown.components"
          :key="part.key"
          class="rating-break-row"
        >
          <span class="rating-break-name">
            {{ part.key === 'RANK' ? '段位' : '社区出勤' }}
          </span>
          <div class="rating-break-bar">
            <i :style="{ width: `${Math.round(part.value * 100)}%` }"></i>
          </div>
          <span class="rating-break-score mono">
            {{ part.score }}<span class="muted"> / {{ part.weight }}</span>
          </span>
        </div>
        <p class="rating-break-note muted">
          <template v-if="typeof rating.breakdown.attendanceBp === 'number'">
            出勤率 {{ (rating.breakdown.attendanceBp / 100).toFixed(0) }}% ·
          </template>
          <template v-else>还没有已结束的赛事，出勤按满分计 ·</template>
          <template v-if="typeof rating.breakdown.estimatedMmr === 'number'">
            估算 MMR {{ rating.breakdown.estimatedMmr }}
          </template>
          <template v-else>缺少段位数据，按中性值计</template>
        </p>
      </div>

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
