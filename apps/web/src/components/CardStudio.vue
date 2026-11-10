<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NButton, NModal, NSlider } from 'naive-ui';
import CardLineFX from './CardLineFX.vue';
import PlayerCard, { type PlayerCardData } from './PlayerCard.vue';
import {
  MIRROR_PARAM_RANGES,
  getMirrorParams,
  resetMirrorParams,
  setMirrorParams,
  type MirrorParams,
} from '../lib/mirror';
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

/* ---------------------------------------------------------------- 镜面调参 */
/* 着色器里所有可变的量都在这一组里。改任何一个立刻应用到全站（模块级参数），
   所以预览卡要顶一个 revision 才会重画一帧。
   值只存本机 localStorage——这是调参，不是用户数据；定稿后把默认值写进
   lib/mirror.ts 的 DEFAULT_MIRROR_PARAMS 再发版。 */

interface TuningItem {
  key: keyof MirrorParams;
  label: string;
  hint: string;
  step: number;
}

/** 常用：对齐参考组件的旋钮密度，一屏看得完，调效果只需要动这几项 */
const MIRROR_TUNING_MAIN: { title: string; note: string; items: TuningItem[] }[] = [
  {
    title: '外观',
    note: '金属度 / 模糊 / 去色 / 高光 / 柔光',
    items: [
      { key: 'metalness', label: '金属度', hint: '0 = 哑光，反射几乎消失；1 = 纯金属', step: 0.01 },
      { key: 'sceneLod', label: '模糊', hint: '清晰的原图会像贴纸；2 以上才像"远处的屋子"', step: 0.1 },
      { key: 'grayscale', label: '去色', hint: '把反射画面压成灰的', step: 0.01 },
      { key: 'specGain', label: '高光', hint: '0 就是完全没有点状高光', step: 0.05 },
      { key: 'glare', label: '柔光', hint: '跟着鼠标走的那团光', step: 0.01 },
    ],
  },
  {
    title: '形变',
    note: '场景里直线会不会弯，只由这两项决定',
    items: [
      { key: 'warp', label: '形变', hint: '0 = 画面完全平直（直线还是直线）；越大边缘越往中心收', step: 0.01 },
      { key: 'warpScale', label: '形变尺度', hint: '越大，越早开始弯', step: 0.01 },
      { key: 'tiltGain', label: '倾斜强度', hint: '指针带动画面平移的幅度；0.2 以上会像在拖动画面', step: 0.01 },
      { key: 'rimStart', label: '倒角', hint: '0.98 只留最外圈；0.7 是宽宽一圈', step: 0.01 },
    ],
  },
  {
    title: '表面',
    note: '只改质感，不会让画面变形',
    items: [
      { key: 'brush', label: '拉丝', hint: '横向细纹的亮度调制——金属拉丝感来自这里', step: 0.001 },
      { key: 'polish', label: '抛光起伏', hint: '只进高光，不进反射取样', step: 0.001 },
      { key: 'sceneGain', label: '场景亮度', hint: '整体曝光，压暗会让画面更沉', step: 0.01 },
    ],
  },
];

/** 高级：诊断与微调用。默认折叠，平时不用动 */
const MIRROR_TUNING_ADVANCED: { title: string; note: string; items: TuningItem[] }[] = [
  {
    title: '取样范围',
    note: '看得见场景的多大一块',
    items: [
      { key: 'spanX', label: '横向跨度', hint: '越小越"放大"；太大会把左右立柱挤出画面', step: 0.01 },
      { key: 'spanY', label: '纵向跨度', hint: '越大映到的地面越多', step: 0.01 },
    ],
  },
  {
    title: '肖像灯',
    note: '本人头像在场景里挂在哪、亮成什么样',
    items: [
      {
        key: 'spotX',
        label: '灯 · 横向',
        hint: '场景图 uv 的横坐标；避开卡面左半边（名字在那儿）',
        step: 0.01,
      },
      {
        key: 'spotY',
        label: '灯 · 纵向',
        hint: '地平线在 0.47 附近，必须大于它，否则灯会落在地上',
        step: 0.01,
      },
      { key: 'spotRadius', label: '灯 · 半径', hint: '太小会变成一个小光点', step: 0.005 },
      { key: 'spotStrength', label: '灯 · 强度', hint: '和场景混合的程度', step: 0.01 },
      { key: 'avatarGain', label: '头像提亮', hint: '头像大多偏暗，靠它才亮得起来', step: 0.1 },
      {
        key: 'lampWarm',
        label: '暖光灯罩',
        hint: '整间屋子是冷蓝的，这圈暖光是唯一的"你"',
        step: 0.01,
      },
    ],
  },
  {
    title: '光影',
    note: '板面弧度只影响折射出来的亮暗，不影响取样',
    items: [
      { key: 'curvX', label: '横向弧度', hint: '只进光照法线，不影响画面', step: 0.01 },
      { key: 'curvY', label: '纵向弧度', hint: '同上；给大了高光会拧成波浪', step: 0.01 },
      { key: 'specPower', label: '高光锐度', hint: '指数越大，亮点越小越硬', step: 10 },
      { key: 'exposure', label: '曝光', hint: '色调映射强度，1.0 以上开始发白', step: 0.01 },
      { key: 'grain', label: '颗粒', hint: '完全没有会像塑料', step: 0.001 },
      { key: 'rimGain', label: '倒角亮度', hint: '按光来的方向加权，左上亮右下暗', step: 0.01 },
      { key: 'bevelShade', label: '板内压暗', hint: '紧贴边内侧压一道，制造倒角面', step: 0.01 },
    ],
  },
];

const showMirrorTuning = ref(false);
/** 高级参数默认折叠：常用那十几项就够调效果了 */
const showAdvancedTuning = ref(false);
const advancedCount = MIRROR_TUNING_ADVANCED.reduce((total, group) => total + group.items.length, 0);
const visibleGroups = computed(() =>
  showAdvancedTuning.value
    ? [...MIRROR_TUNING_MAIN, ...MIRROR_TUNING_ADVANCED]
    : MIRROR_TUNING_MAIN,
);
const tuning = ref<MirrorParams>(getMirrorParams());
/** 参数变了之后顶一下这个计数，预览卡才会重画 */
const tuningRevision = ref(0);
const tuningCopied = ref(false);

/** 小数位跟着步长走：0.001 的步长只显示 3 位就别显示 6 位 */
function tuningDigits(step: number): number {
  if (step >= 1) return 0;
  return step >= 0.1 ? 1 : 3;
}

function openMirrorTuning() {
  tuning.value = getMirrorParams();
  tuningCopied.value = false;
  showMirrorTuning.value = true;
}

function updateParam(key: keyof MirrorParams, value: number) {
  const next = { ...tuning.value };
  next[key] = value;
  tuning.value = setMirrorParams(next);
  tuningRevision.value += 1;
}

function resetTuning() {
  tuning.value = resetMirrorParams();
  tuningRevision.value += 1;
}

async function copyTuning() {
  try {
    await navigator.clipboard.writeText(JSON.stringify(tuning.value, null, 2));
    tuningCopied.value = true;
    setTimeout(() => {
      tuningCopied.value = false;
    }, 1800);
  } catch {
    tuningCopied.value = false;
  }
}
</script>

<template>
  <div class="skin-studio">
    <div class="skin-preview">
      <PlayerCard :player="previewPlayer" :revision="tuningRevision" />
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

      <!-- 选中「镜面」才出现的调参入口：着色器里所有可变量都在那个弹窗里 -->
      <div v-if="draft.material === 'mirror'" class="skin-frame-style">
        <button
          type="button"
          class="skin-frame-style-btn"
          aria-haspopup="dialog"
          @click="openMirrorTuning"
        >
          <span class="skin-frame-style-copy">
            <span class="skin-frame-style-title">调整参数</span>
            <span class="skin-frame-style-hint">
              金属度、模糊、去色、高光、柔光、形变、拉丝…（12 项常用，高级另 15 项）
            </span>
          </span>
          <span class="skin-frame-style-open">调整</span>
        </button>
      </div>

      <div class="skin-actions">
        <NButton :disabled="saving" @click="commit(randomCardSkin(props.founder === true))">
          随便换一个
        </NButton>        <NButton quaternary :disabled="saving" @click="commit({ ...DEFAULT_CARD_SKIN })">
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

    <!-- 镜面调参：滑块一动就重画预览卡（材质参数是模块级的，不用存盘） -->
    <NModal
      v-model:show="showMirrorTuning"
      preset="card"
      title="镜面 · 调整参数"
      :bordered="false"
      style="width: 600px; max-width: calc(100vw - 32px)"
    >
      <!-- 弹窗盖住了页面左边那张预览卡，所以这里再放一张：调参时必须能同时
           看到卡片。它留在滚动区域**外面**，往下翻参数时也不会滚走。 -->
      <div class="mirror-tuning-preview">
        <PlayerCard :player="previewPlayer" :revision="tuningRevision" />
      </div>

      <div class="mirror-tuning">
        <!-- 高级参数默认折叠：常用那十几项就够调效果了，剩下的都是诊断/微调 -->
        <div class="mirror-tuning-more">
          <NButton size="tiny" quaternary @click="showAdvancedTuning = !showAdvancedTuning">
            {{ showAdvancedTuning ? '收起高级参数' : `展开高级参数（${advancedCount} 项）` }}
          </NButton>
        </div>

        <section v-for="group in visibleGroups" :key="group.title" class="mirror-tuning-group">
          <div class="frame-style-head">
            <span class="frame-style-heading">{{ group.title }}</span>
            <span class="frame-style-note">{{ group.note }}</span>
          </div>
          <div v-for="item in group.items" :key="item.key" class="mirror-tuning-row">
            <span class="mirror-tuning-label">
              {{ item.label }}
              <span class="mirror-tuning-value mono">
                {{ tuning[item.key].toFixed(tuningDigits(item.step)) }}
              </span>
            </span>
            <NSlider
              :value="tuning[item.key]"
              :min="MIRROR_PARAM_RANGES[item.key][0]"
              :max="MIRROR_PARAM_RANGES[item.key][1]"
              :step="item.step"
              :tooltip="false"
              @update:value="(value: number) => updateParam(item.key, value)"
            />
            <span class="mirror-tuning-hint">{{ item.hint }}</span>
          </div>
        </section>
      </div>

      <div class="frame-style-footer mirror-tuning-footer">
        <span class="frame-style-footer-note">
          存在本机浏览器，只影响你这台设备；定稿后告诉我，我把默认值改掉再发版。
        </span>
        <div class="mirror-tuning-actions">
          <NButton size="small" @click="copyTuning">{{ tuningCopied ? '已复制' : '复制参数' }}</NButton>
          <NButton size="small" @click="resetTuning">恢复默认</NButton>
          <NButton type="primary" size="small" @click="showMirrorTuning = false">完成</NButton>
        </div>
      </div>
    </NModal>
  </div>
</template>
