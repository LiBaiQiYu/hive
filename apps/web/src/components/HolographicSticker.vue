<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { renderHoloFrame } from '../lib/holo';

/**
 * 全息贴纸（Holographic Foil Sticker）
 *
 * 层次（全部绝对定位、互相独立）：
 *   base   深色金属底板
 *   foil   虹彩薄膜（柔光斑，静态底色）
 *   facets 微晶切面（canvas 程序化渲染，逐面算法线 + 光栅色相）
 *   sheen  镜面高光带（角度随鼠标）
 *   rim    金属外框（颜色跟膜一起变，可关）
 *   gloss  透明树脂柔光
 *
 * facets 不是贴图：lib/holo.ts 里按"每个三角面一个法线 → 半程向量 →
 * 镜面强度 + 衍射色相"实时绘制，所以倾斜时颜色真的会从蓝紫滑到黄绿，
 * 而不是同一张图平移。
 */
const props = withDefaults(
  defineProps<{
    /** 0..1，整体全息强度 */
    intensity?: number;
    /** 跟随鼠标调整反射中心、高光角度与色相 */
    interactive?: boolean;
    /** 是否绘制金属外框 */
    rim?: boolean;
    radius?: number | string;
    /** 铺满父容器（当卡片背景用） */
    surface?: boolean;
    /** 外部驱动的倾斜（-1..1）：卡片自己算好了指针位置时用它，组件内不再监听 */
    tiltX?: number;
    tiltY?: number;
  }>(),
  { intensity: 0.9, interactive: true, rim: true, radius: 14, surface: false },
);

const root = ref<HTMLElement | null>(null);
const canvasEl = ref<HTMLCanvasElement | null>(null);
const light = ref({ x: 32, y: 28 });

/**
 * 实际光照位置：卡片把倾角传进来时以它为准。
 * （组件放在 .pcard-deco 里，那层是 pointer-events: none，收不到鼠标事件；
 *  只用自己的 light 状态的话，镜面高光会定死在初始位置——卡片怎么晃都不动。）
 */
const resolvedLight = computed(() => {
  if (props.tiltX !== undefined && props.tiltY !== undefined) {
    return { x: (props.tiltX + 1) * 50, y: (props.tiltY + 1) * 50 };
  }
  return light.value;
});

let raf = 0;
let observer: ResizeObserver | null = null;

/** 按当前光照渲染一帧，并把色相写回 CSS（外框/高光共用同一个色相） */
function paint() {
  const el = root.value;
  const canvas = canvasEl.value;
  if (!el || !canvas) return;
  // clientWidth/Height 是布局尺寸（不受 3D 倾斜影响），比 getBoundingClientRect 稳
  const width = el.clientWidth;
  const height = el.clientHeight;
  if (!width || !height) return;
  const pos = resolvedLight.value;
  const tiltX = (pos.x - 50) / 50;
  const tiltY = (pos.y - 50) / 50;
  const hue = renderHoloFrame(canvas, width, height, {
    tiltX,
    tiltY,
    intensity: props.intensity,
  });
  el.style.setProperty('--foil-hue', hue.toFixed(1));
}

function schedule() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    paint();
  });
}

function onPointerMove(event: PointerEvent) {
  if (!props.interactive || event.pointerType === 'touch') return;
  const el = root.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const x = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  const y = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
  light.value = { x: x * 100, y: y * 100 };
  schedule();
}

function onPointerLeave() {
  light.value = { x: 32, y: 28 };
  schedule();
}

onMounted(() => {
  paint();
  observer = new ResizeObserver(schedule);
  if (root.value) observer.observe(root.value);
});

onBeforeUnmount(() => {
  if (raf) cancelAnimationFrame(raf);
  observer?.disconnect();
  observer = null;
});

watch(
  () => props.intensity,
  () => schedule(),
);

watch(
  () => [props.tiltX, props.tiltY],
  () => schedule(),
);

const vars = computed(() => {
  const pos = resolvedLight.value;
  return {
    '--foil-light-x': `${pos.x.toFixed(1)}%`,
    '--foil-light-y': `${pos.y.toFixed(1)}%`,
    // 高光带的角度跟着横向位置转：左边 70°，右边 150°，像斜着扫过箔面
    '--foil-angle': `${(70 + (pos.x / 100) * 80).toFixed(1)}deg`,
    '--foil-intensity': String(props.intensity),
    '--foil-radius': typeof props.radius === 'number' ? `${props.radius}px` : props.radius,
  };
});
</script>

<template>
  <div
    ref="root"
    class="hsticker"
    :class="{ 'is-interactive': interactive, 'is-surface': surface }"
    :style="vars"
    @pointermove="onPointerMove"
    @pointerleave="onPointerLeave"
  >
    <div class="hsticker-base" />
    <div class="hsticker-foil" />
    <canvas ref="canvasEl" class="hsticker-facets" />
    <div class="hsticker-sheen" />
    <div v-if="rim" class="hsticker-rim" />
    <div class="hsticker-gloss" />
    <slot />
  </div>
</template>

<style scoped>
.hsticker {
  --foil-light-x: 32%;
  --foil-light-y: 28%;
  --foil-angle: 96deg;
  --foil-intensity: 0.9;
  --foil-radius: 14px;
  --foil-hue: 240;

  position: relative;
  border-radius: var(--foil-radius);
  overflow: hidden;
  isolation: isolate;
  background: linear-gradient(160deg, #0d1824 0%, #0a121c 45%, #0e1a26 100%);
}

.hsticker > div {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.hsticker-facets {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

/* 1. 深色底板：内凹的金属质感 */
.hsticker-base {
  background:
    radial-gradient(120% 90% at var(--foil-light-x) var(--foil-light-y), rgba(60, 110, 150, 0.25), transparent 60%),
    linear-gradient(160deg, #0d1824 0%, #0a121c 45%, #0e1a26 100%);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.18),
    inset 0 -6px 14px rgba(0, 0, 0, 0.55),
    inset 0 0 24px rgba(0, 0, 0, 0.45);
}

/* 2. 虹彩薄膜：柔光斑垫在切面下面，负责"膜"的整体色调 */
.hsticker-foil {
  background-image: url('../assets/card-holo-foil.svg');
  background-size: cover;
  background-repeat: no-repeat;
  opacity: calc(var(--foil-intensity) * 0.55);
  transform: translate3d(
    calc((var(--foil-light-x) - 50%) * 0.16),
    calc((var(--foil-light-y) - 50%) * 0.16),
    0
  ) scale(1.04);
}

/* 4. 镜面高光带 */
.hsticker-sheen {
  background:
    linear-gradient(
      var(--foil-angle),
      transparent 24%,
      rgba(255, 255, 255, 0.24) 40%,
      rgba(255, 255, 255, 0.06) 50%,
      transparent 66%
    ),
    radial-gradient(
      55% 50% at var(--foil-light-x) var(--foil-light-y),
      rgba(255, 255, 255, calc(var(--foil-intensity) * 0.28)),
      transparent 70%
    );
}

/* 5. 金属外框：颜色跟膜一起变 */
.hsticker-rim {
  border-radius: inherit;
  box-shadow:
    inset 0 0 0 2px hsl(var(--foil-hue) 65% 72% / 0.55),
    inset 0 0 0 3px rgba(8, 13, 20, 0.9),
    inset 0 1px 0 rgba(255, 255, 255, 0.4),
    inset 0 -4px 10px rgba(0, 0, 0, 0.5),
    inset 0 0 18px hsl(var(--foil-hue) 80% 60% / 0.25);
}

/* 6. 透明树脂 */
.hsticker-gloss {
  background: radial-gradient(
    38% 30% at calc(var(--foil-light-x) - 12%) calc(var(--foil-light-y) - 16%),
    rgba(255, 255, 255, 0.22),
    transparent 72%
  );
}

.is-surface {
  position: absolute;
  inset: 0;
  border-radius: inherit;
}

@media (prefers-reduced-motion: reduce) {
  .hsticker-foil {
    transform: none;
  }
}
</style>
