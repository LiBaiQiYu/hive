<script lang="ts">
/**
 * 走 GPU 合成的边框特效：霜线 / 电光 / 四角。
 * 雷纹（arc）仍是逐帧图，不在这个组件里。
 */
export type FrameFXKind = 'frost' | 'spark' | 'corners';
</script>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';

defineProps<{ kind: FrameFXKind }>();

interface Glint {
  x: number;
  y: number;
  n: number;
}

interface SparkDot {
  x: number;
  y: number;
  dx: number;
  dy: number;
  n: number;
}

/**
 * 霜的闪光点：位置贴着四条边，避免全挤在角上。
 * n 同时当作相位序号：每个点用不同的负延迟错开闪烁。
 */
const FROST_GLINTS: Glint[] = [
  { x: 7, y: 1.4, n: 1 },
  { x: 34, y: 0.4, n: 2 },
  { x: 71, y: 1.2, n: 3 },
  { x: 96.5, y: 16, n: 4 },
  { x: 97, y: 62, n: 5 },
  { x: 57, y: 98, n: 6 },
  { x: 21, y: 96, n: 7 },
  { x: 1.2, y: 44, n: 8 },
];

/**
 * 电光的游离粒子：dx/dy 是飞出方向（只乘几 px），
 * 每个粒子的周期长度也不一样，避免出现"整排一起闪"的机械感。
 */
const SPARK_DOTS: SparkDot[] = [
  { x: 10, y: 1.8, dx: -0.5, dy: -1, n: 1 },
  { x: 44, y: 0.6, dx: 0.2, dy: -1, n: 2 },
  { x: 79, y: 2.4, dx: 0.8, dy: -0.6, n: 3 },
  { x: 98, y: 24, dx: 1, dy: 0.4, n: 4 },
  { x: 98, y: 64, dx: 0.8, dy: 1, n: 5 },
  { x: 54, y: 98, dx: -0.3, dy: 1, n: 6 },
  { x: 17, y: 98, dx: -0.9, dy: 0.5, n: 7 },
  { x: 1.5, y: 56, dx: -1, dy: -0.2, n: 8 },
];

/** 四角：四个角共用一份 markup，靠 CSS 的 scale(-1) 镜像到另外三个角。
    顺序按顺时针（tl → tr → br → bl），角光的相位也就跟着转一圈。 */
const CORNERS = ['tl', 'tr', 'br', 'bl'] as const;

const root = ref<HTMLElement | null>(null);
let observer: ResizeObserver | null = null;

/**
 * 旋转的 conic-gradient 层必须是个能盖住整张卡的正方形（边长 = 对角线），
 * 否则宽卡旋转到 45° 时四角会露空。这个尺寸 CSS 算不出来，量一次交给变量。
 * 只在尺寸变化时写一次，不参与逐帧计算。
 */
function measure() {
  const node = root.value;
  if (!node) return;
  const width = node.offsetWidth;
  const height = node.offsetHeight;
  if (!width || !height) return;
  node.style.setProperty('--pcfx-size', `${Math.ceil(Math.hypot(width, height)) + 2}px`);
}

onMounted(() => {
  measure();
  observer = new ResizeObserver(measure);
  if (root.value) observer.observe(root.value);
});

onBeforeUnmount(() => {
  observer?.disconnect();
  observer = null;
});
</script>

<template>
  <div ref="root" class="pcfx" :data-fx="kind" aria-hidden="true">
    <!-- 静态底线：box-shadow 画，圆角永远准确 -->
    <div class="pcfx-line" />
    <!-- 向内的辉光 / 四角结霜，放在亮线下面 -->
    <div class="pcfx-inner" />

    <!-- 1px 遮罩环：旋转的 conic-gradient 只有落在环带上的部分可见 -->
    <div class="pcfx-ring">
      <div class="pcfx-spin">
        <div class="pcfx-rail" />
        <div class="pcfx-sweep pcfx-sweep--a" />
        <div class="pcfx-sweep pcfx-sweep--b" />
        <div class="pcfx-pulse" />
        <!-- 电光：几段很短的亮弧，偶尔闪一下；始终留在边框上，不会压到文字 -->
        <div v-if="kind === 'spark'" class="pcfx-arc" />
      </div>
    </div>

    <template v-if="kind === 'frost'">
      <div class="pcfx-ice" />
      <i
        v-for="glint in FROST_GLINTS"
        :key="glint.n"
        class="pcfx-glint"
        :style="{ left: `${glint.x}%`, top: `${glint.y}%`, '--n': glint.n }"
      />
    </template>

    <template v-else-if="kind === 'spark'">
      <i
        v-for="dot in SPARK_DOTS"
        :key="dot.n"
        class="pcfx-dot"
        :style="{
          left: `${dot.x}%`,
          top: `${dot.y}%`,
          '--dx': dot.dx,
          '--dy': dot.dy,
          '--n': dot.n,
        }"
      />
    </template>

    <!-- 四角：每个角两条臂 + 两颗沿臂巡游的光点 + 角尖星点。
         --n 用来错开四个角的相位，一屏十几张卡不会同时闪。 -->
    <div v-else class="pcfx-corners">
      <div
        v-for="(corner, index) in CORNERS"
        :key="corner"
        class="pcfx-corner"
        :class="`pcfx-corner--${corner}`"
        :style="{ '--n': index }"
      >
        <i class="pcfx-arm pcfx-arm--h" />
        <i class="pcfx-arm pcfx-arm--v" />
        <i class="pcfx-corner-glow" />
        <i class="pcfx-scan pcfx-scan--h" />
        <i class="pcfx-scan pcfx-scan--v" />
        <i class="pcfx-tip" />
      </div>
    </div>
  </div>
</template>
