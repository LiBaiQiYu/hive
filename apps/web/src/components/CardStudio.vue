<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NButton } from 'naive-ui';
import PlayerCard, { type PlayerCardData } from './PlayerCard.vue';
import {
  CARD_FRAME_OPTIONS,
  CARD_MATERIAL_OPTIONS,
  DEFAULT_CARD_SKIN,
  randomCardSkin,
  type CardSkin,
} from '../lib/cards';

/**
 * 卡片外观设置面板：左边实时预览、右边两组选项（材质 / 边框）。
 * 面板自己不存盘，选中即 emit —— 保存策略（防抖 / 失败回滚）留给页面决定。
 */
const props = defineProps<{
  player: PlayerCardData;
  modelValue: CardSkin;
  saving?: boolean;
  status?: string;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: CardSkin] }>();

/**
 * 本地草稿：props 要等父组件重渲染才更新，连着点两个维度时
 * 直接读 props 会拿到上一次的旧值（点了像素+全息，结果存成 金+全息）。
 */
const draft = ref<CardSkin>({ ...props.modelValue });
watch(
  () => props.modelValue,
  (value) => {
    draft.value = { ...value };
  },
  { deep: true },
);

const previewPlayer = computed<PlayerCardData>(() => ({ ...props.player, skin: draft.value }));

const hints = computed(() => ({
  material: CARD_MATERIAL_OPTIONS.find((option) => option.value === draft.value.material)?.hint ?? '',
  frame: CARD_FRAME_OPTIONS.find((option) => option.value === draft.value.frame)?.hint ?? '',
}));

function commit(next: CardSkin) {
  draft.value = next;
  emit('update:modelValue', { ...next });
}

function pick<K extends keyof CardSkin>(key: K, value: CardSkin[K]) {
  if (draft.value[key] === value) return;
  commit({ ...draft.value, [key]: value });
}
</script>

<template>
  <div class="skin-studio">
    <div class="skin-preview">
      <PlayerCard :player="previewPlayer" />
      <p class="skin-preview-note muted">
        别人在报名名单里看到的就是这张卡。悬停可以试倾斜，皮肤只影响外观，
        不会动评分、段位和位置。
      </p>
    </div>

    <div class="skin-controls">
      <div class="skin-group" role="radiogroup" aria-label="卡片材质">
        <div class="skin-group-head">
          材质
          <span class="skin-group-hint">{{ hints.material }}</span>
        </div>
        <div class="skin-swatches">
          <button
            v-for="option in CARD_MATERIAL_OPTIONS"
            :key="option.value"
            type="button"
            class="skin-swatch"
            :class="{ 'is-active': draft.material === option.value }"
            role="radio"
            :aria-checked="draft.material === option.value"
            :title="option.hint"
            @click="pick('material', option.value)"
          >
            <span class="skin-chip" :data-material="option.value" aria-hidden="true" />
            <span class="skin-swatch-label">{{ option.label }}</span>
          </button>
        </div>
      </div>

      <div class="skin-group" role="radiogroup" aria-label="卡片边框">
        <div class="skin-group-head">
          边框
          <span class="skin-group-hint">{{ hints.frame }}</span>
        </div>
        <div class="skin-swatches">
          <button
            v-for="option in CARD_FRAME_OPTIONS"
            :key="option.value"
            type="button"
            class="skin-swatch"
            :class="{ 'is-active': draft.frame === option.value }"
            role="radio"
            :aria-checked="draft.frame === option.value"
            :title="option.hint"
            @click="pick('frame', option.value)"
          >
            <span
              class="skin-chip skin-chip--frame"
              :data-frame="option.value"
              aria-hidden="true"
            />
            <span class="skin-swatch-label">{{ option.label }}</span>
          </button>
        </div>
      </div>

      <div class="skin-actions">
        <NButton :disabled="saving" @click="commit(randomCardSkin())">随便换一个</NButton>
        <NButton quaternary :disabled="saving" @click="commit({ ...DEFAULT_CARD_SKIN })">
          恢复默认
        </NButton>
        <span class="skin-status">{{ saving ? '保存中…' : (status ?? '') }}</span>
      </div>
    </div>
  </div>
</template>
