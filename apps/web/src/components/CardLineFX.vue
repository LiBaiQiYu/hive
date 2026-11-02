<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import type { CardFrameColor, CardFrameEffect } from '../lib/cards';

/**
 * 发丝线 / 双线的颜色与光效层。
 *
 * 原生边框只能是一个纯色，而且改 border-color / box-shadow 会触发重绘；
 * 这里把描边搬到独立的一层：
 *   - 纯色：1px / 2px 的静态 border，内外各一层柔和辉光；
 *   - 流动彩色：conic-gradient 塞进 1px 遮罩环，旋转只动 transform；
 *   - 呼吸 / 闪烁：只动整层 opacity。
 * 三种运动全在合成器上，和卡片的 3D 倾斜互不干扰。
 */
const props = defineProps<{
  color: CardFrameColor;
  effect: CardFrameEffect;
  double: boolean;
}>();

const root = ref<HTMLElement | null>(null);
let observer: ResizeObserver | null = null;

/**
 * 旋转的 conic 层必须是个能盖住整张卡的正方形（边长 = 对角线）。
 * CSS 算不出对角线，量一次交给 --cline-size；只在尺寸变化时写。
 */
function measure() {
  const node = root.value;
  if (!node) return;
  const width = node.offsetWidth;
  const height = node.offsetHeight;
  if (!width || !height) return;
  node.style.setProperty('--cline-size', `${Math.ceil(Math.hypot(width, height)) + 2}px`);
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
  <div
    ref="root"
    class="cline"
    :data-color="props.color"
    :data-effect="props.effect"
    :data-double="props.double ? 'true' : 'false'"
    aria-hidden="true"
  >
    <span class="cline-bloom" />
    <template v-if="props.color === 'rainbow'">
      <span class="cline-band cline-band--outer">
        <i class="cline-rotor" />
      </span>
      <span v-if="props.double" class="cline-band cline-band--inner">
        <i class="cline-rotor" />
      </span>
    </template>
    <template v-else>
      <span class="cline-stroke cline-stroke--outer" />
      <span v-if="props.double" class="cline-stroke cline-stroke--inner" />
    </template>
  </div>
</template>
