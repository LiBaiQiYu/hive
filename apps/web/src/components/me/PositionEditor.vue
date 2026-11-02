<script setup lang="ts">
/**
 * 位置偏好编辑器（我的主页）。
 *
 * 为什么不像卡片外观那样点了就自动保存：志愿必须从第 1 志愿开始连续填写，
 * 中途的状态（把 1 号位改成「不打」、2 号位还没来得及提上来）是非法数据，
 * 防抖提交只会把半成品写进库里。所以保留显式保存，另配两件事：
 *   · 未保存提示（按钮旁边）
 *   · 离开页面时确认，避免手滑丢掉刚拖的熟练度
 */
import { computed, ref, watch } from 'vue';
import { onBeforeRouteLeave } from 'vue-router';
import { NButton, NSelect, useDialog, useMessage } from 'naive-ui';
import HelpTip from '../HelpTip.vue';
import { ApiError, api } from '../../lib/api';
import { loadMe, session } from '../../lib/session';

interface Slot {
  position: number;
  rank: number;
  proficiency: number;
}

const POSITION_NAMES: Record<number, string> = {
  1: '1 号位 · 优势路核心',
  2: '2 号位 · 中路',
  3: '3 号位 · 劣势路',
  4: '4 号位 · 游走辅助',
  5: '5 号位 · 保人辅助',
};

const slots = ref<Slot[]>([
  { position: 1, rank: 0, proficiency: 60 },
  { position: 2, rank: 0, proficiency: 60 },
  { position: 3, rank: 0, proficiency: 60 },
  { position: 4, rank: 0, proficiency: 60 },
  { position: 5, rank: 0, proficiency: 60 },
]);

const saving = ref(false);
const error = ref('');
const saved = ref(false);
const message = useMessage();
const dialog = useDialog();

/** 与"服务端那份"对齐的快照，用来判断有没有未保存的改动 */
const baseline = ref('');
const hydrated = ref(false);

function signature(list: Slot[]) {
  return list.map((slot) => `${slot.position}:${slot.rank}:${slot.proficiency}`).join('|');
}

function fillFromProfile(positions: { position: number; rank: number; proficiency: number }[]) {
  slots.value = [1, 2, 3, 4, 5].map((position) => {
    const found = positions.find((item) => item.position === position);
    return {
      position,
      rank: found?.rank ?? 0,
      proficiency: found?.proficiency ?? 60,
    };
  });
  baseline.value = signature(slots.value);
  hydrated.value = true;
}

const dirty = computed(() => hydrated.value && signature(slots.value) !== baseline.value);

// 切换账号或刷新后重新填充；但本地有未保存的草稿时不要被覆盖
// （比如刚在「管理身份」里存了段位，会顺带 loadMe 一次）
watch(
  () => session.me?.positions,
  (positions) => {
    if (!positions) return;
    if (hydrated.value && dirty.value) return;
    fillFromProfile(positions);
  },
  { deep: true, immediate: true },
);

/** 已被占用的志愿，用于禁止重复选择 */
const usedRanks = computed(
  () => new Set(slots.value.filter((slot) => slot.rank > 0).map((slot) => slot.rank)),
);

/** 志愿下拉：已被别的位置占用的档位不再出现，避免"选完再报错" */
function rankSelectOptions(slot: Slot) {
  return [0, 1, 2, 3, 4, 5]
    .filter((rank) => rank === 0 || rank === slot.rank || !usedRanks.value.has(rank))
    .map((rank) => ({ label: rank === 0 ? '不打' : `第 ${rank} 志愿`, value: rank }));
}

const chosen = computed(() =>
  slots.value.filter((slot) => slot.rank > 0).sort((a, b) => a.rank - b.rank),
);

/** 志愿必须从 1 连续递增，和后端规则保持一致 */
const contiguous = computed(() => chosen.value.every((slot, index) => slot.rank === index + 1));

const canSave = computed(() => contiguous.value && dirty.value && !saving.value);

async function save(): Promise<boolean> {
  if (!contiguous.value || saving.value) return false;
  saving.value = true;
  error.value = '';
  saved.value = false;
  try {
    await api('/me/positions', {
      method: 'PUT',
      body: chosen.value.map((slot) => ({
        position: slot.position,
        rank: slot.rank,
        proficiency: slot.proficiency,
      })),
    });
    // 先把草稿认成"已保存"，否则下面的 loadMe 会以为还有未保存改动、不去刷新
    baseline.value = signature(slots.value);
    await loadMe();
    saved.value = true;
    message.success('位置偏好已保存');
    return true;
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '保存失败';
    return false;
  } finally {
    saving.value = false;
  }
}

/** 有未保存改动时拦下导航：保存成功才放行，报错就留在原地 */
onBeforeRouteLeave(async () => {
  // 退出登录会先把 session 清空再跳转，这时候没有可保存的东西，别拿弹窗拦人
  if (!session.me || !dirty.value) return true;
  return new Promise<boolean>((resolve) => {
    dialog.warning({
      title: '位置偏好还没保存',
      content: '离开后这次改的志愿和熟练度会丢失。',
      positiveText: '保存后离开',
      negativeText: '放弃改动',
      maskClosable: false,
      closeOnEsc: false,
      onPositiveClick: async () => {
        resolve(await save());
      },
      onNegativeClick: () => {
        resolve(true);
      },
      onClose: () => {
        resolve(false);
      },
    });
  });
});
</script>

<template>
  <section class="card section">
    <h2 class="card-title">
      位置偏好
      <HelpTip
        wide
        title="志愿和熟练度怎么用？"
        :steps="[
          '① 志愿顺序决定分队时你被安排的位置；只填一个位置，队伍里就必然有人打不上本命位',
          '② 熟练度是你在这个位置的真实水平：100 = 完全胜任，0 = 勉强能顶',
          '③ 契合度 = 志愿基准（第一志愿 100，之后每降一档 −20）+ 熟练度修正（±25）',
        ]"
        note="熟练度只影响分队时的位置契合度，不影响 WARROOM 评分。建议填 3–5 个位置；保存后下次生成阵容才生效，已公布的阵容不会变。"
      />
    </h2>

    <div class="pos-head">
      <span>位置</span>
      <span>志愿顺序</span>
      <span>熟练度 0–100</span>
    </div>

    <div class="pos-list">
      <div v-for="slot in slots" :key="slot.position" class="pos-row">
        <div class="pos-name">{{ POSITION_NAMES[slot.position] }}</div>

        <NSelect
          v-model:value="slot.rank"
          :options="rankSelectOptions(slot)"
          class="pos-select"
          size="medium"
        />

        <div class="pos-prof">
          <input
            v-model.number="slot.proficiency"
            type="range"
            min="0"
            max="100"
            step="5"
            :disabled="slot.rank === 0"
          />
          <span class="mono muted" style="width: 34px; text-align: right">
            {{ slot.rank === 0 ? '—' : slot.proficiency }}
          </span>
        </div>
      </div>
    </div>

    <p v-if="!contiguous" class="alert" style="margin-top: 16px">
      志愿顺序必须从第 1 志愿开始连续填写，不能跳档。
    </p>

    <p v-if="error" class="alert" style="margin-top: 16px">{{ error }}</p>
    <p v-if="saved && !dirty" class="muted" style="margin-top: 16px">
      已保存。下次生成阵容时生效——已发布的阵容不会因为改偏好而变化。
    </p>

    <div style="margin-top: 18px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap">
      <NButton type="primary" :disabled="!canSave" :loading="saving" @click="save()">
        {{ saving ? '保存中…' : '保存位置偏好' }}
      </NButton>
      <span class="muted" style="font-size: 12px">已选 {{ chosen.length }} 个位置</span>
      <span v-if="dirty" class="pos-dirty">有未保存的改动</span>
    </div>
  </section>
</template>
