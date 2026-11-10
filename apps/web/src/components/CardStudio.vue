<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NButton, NModal } from 'naive-ui';
import CardLineFX from './CardLineFX.vue';
import PlayerCard, { type PlayerCardData } from './PlayerCard.vue';
import {
  CARD_FRAME_COLOR_OPTIONS,
  CARD_FRAME_EFFECT_OPTIONS,
  CARD_FRAME_OPTIONS,
  CARD_MATERIAL_OPTIONS,
  DEFAULT_CARD_SKIN,
  isFrameStyleFrame,
  isFounderOnlyMaterial,
  materialOptionsFor,
  optionLabel,
  randomCardSkin,
  type CardFrameColor,
  type CardFrameEffect,
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
  /** 创始人专属材质（无限镜）只对他显示；服务端另有 403 兜底 */
  founder?: boolean;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: CardSkin] }>();

/** 当前身份能看到的材质清单（非创始人看不到无限镜） */
const materialOptions = computed(() => materialOptionsFor(props.founder === true));

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

/* ---------------------------------------------------------------- 颜色 / 光效 */
/* 只有发丝线、双线有额外选项；入口是边框分组下面的一张"颜色与光效"卡片，
   点开才是弹窗。这样默认的边框列表保持原来的密度，不会多出一整栏。 */
const showFrameStyle = ref(false);
const frameStyleFrame = computed(() => isFrameStyleFrame(draft.value.frame));
const frameStyleTitle = computed(
  () => `${optionLabel(CARD_FRAME_OPTIONS, draft.value.frame)} · 颜色与光效`,
);
const frameStyleLabel = computed(
  () =>
    `${optionLabel(CARD_FRAME_COLOR_OPTIONS, draft.value.frameColor)} · ${optionLabel(
      CARD_FRAME_EFFECT_OPTIONS,
      draft.value.frameEffect,
    )}`,
);

watch(
  () => draft.value.frame,
  (frame) => {
    if (!isFrameStyleFrame(frame)) showFrameStyle.value = false;
  },
);

function pickFrameColor(value: CardFrameColor) {
  if (draft.value.frameColor === value) return;
  commit({ ...draft.value, frameColor: value });
}

function pickFrameEffect(value: CardFrameEffect) {
  if (draft.value.frameEffect === value) return;
  commit({ ...draft.value, frameEffect: value });
}

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
            v-for="option in materialOptions"
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
            <span class="skin-swatch-label">
              {{ option.label }}
              <span v-if="isFounderOnlyMaterial(option.value)" class="skin-swatch-owner">
                创始人
              </span>
            </span>
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

      <!-- 只有发丝线 / 双线才出现的额外入口；点开是弹窗，不占边框列表的位置 -->
      <div v-if="frameStyleFrame" class="skin-frame-style">
        <button
          type="button"
          class="skin-frame-style-btn"
          aria-haspopup="dialog"
          @click="showFrameStyle = true"
        >
          <span
            class="frame-color-dot skin-frame-style-dot"
            :data-color="draft.frameColor"
            :data-effect="draft.frameEffect"
            aria-hidden="true"
          />
          <span class="skin-frame-style-copy">
            <span class="skin-frame-style-title">颜色与光效</span>
            <span class="skin-frame-style-hint">{{ frameStyleLabel }}</span>
          </span>
          <span class="skin-frame-style-open">调整</span>
        </button>
      </div>

      <div class="skin-actions">
        <NButton :disabled="saving" @click="commit(randomCardSkin(props.founder === true))">
          随便换一个
        </NButton>
        <NButton quaternary :disabled="saving" @click="commit({ ...DEFAULT_CARD_SKIN })">
          恢复默认
        </NButton>
        <span class="skin-status">{{ saving ? '保存中…' : (status ?? '') }}</span>
      </div>
    </div>

    <NModal
      v-model:show="showFrameStyle"
      preset="card"
      :title="frameStyleTitle"
      :bordered="false"
      style="width: 520px; max-width: calc(100vw - 32px)"
    >
      <div class="frame-style-body">
        <!-- 弹窗会盖住左边的预览卡，这里放一条缩略边框，选色时不用来回关窗 -->
        <div class="frame-style-demo" :data-frame="draft.frame">
          <CardLineFX
            :color="draft.frameColor"
            :effect="draft.frameEffect"
            :double="draft.frame === 'double'"
          />
          <span class="frame-style-demo-text">实时预览</span>
        </div>

        <section class="frame-style-section">
          <div class="frame-style-head">
            <span class="frame-style-heading">颜色</span>
            <span class="frame-style-note">纯色，或流动彩色</span>
          </div>
          <div class="frame-style-colors" role="radiogroup" aria-label="边框颜色">
            <button
              v-for="option in CARD_FRAME_COLOR_OPTIONS"
              :key="option.value"
              type="button"
              class="frame-style-color"
              :class="{ 'is-active': draft.frameColor === option.value }"
              role="radio"
              :aria-checked="draft.frameColor === option.value"
              :title="option.hint"
              @click="pickFrameColor(option.value)"
            >
              <span
                class="frame-color-dot frame-style-swatch"
                :data-color="option.value"
                aria-hidden="true"
              />
              <span class="frame-style-color-label">{{ option.label }}</span>
            </button>
          </div>
        </section>

        <section class="frame-style-section">
          <div class="frame-style-head">
            <span class="frame-style-heading">光效</span>
            <span class="frame-style-note">流动彩色也可以叠加</span>
          </div>
          <div class="frame-style-effects" role="radiogroup" aria-label="边框光效">
            <button
              v-for="option in CARD_FRAME_EFFECT_OPTIONS"
              :key="option.value"
              type="button"
              class="frame-style-effect"
              :class="{ 'is-active': draft.frameEffect === option.value }"
              role="radio"
              :aria-checked="draft.frameEffect === option.value"
              :title="option.hint"
              @click="pickFrameEffect(option.value)"
            >
              <span class="frame-style-effect-name">{{ option.label }}</span>
              <span class="frame-style-effect-hint">{{ option.hint }}</span>
            </button>
          </div>
        </section>

        <div class="frame-style-footer">
          <span class="frame-style-footer-note">
            选中的效果会立即应用到预览，并自动保存。
          </span>
          <NButton type="primary" @click="showFrameStyle = false">完成</NButton>
        </div>
      </div>
    </NModal>
  </div>
</template>
