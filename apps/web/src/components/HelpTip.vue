<script setup lang="ts">
/**
 * 全站统一的「?」提示（样式见 styles-theme.css 的 .help / .help-pop）。
 *
 * 约定：说明、规则、算法这类**静态**文字都收进这里；
 * 随数据变化的警告（人数不匹配、报名已关闭）和操作反馈（错误/成功）仍留在页面上。
 * 用法：跟在标题或字段标签后面，点开是「标题 + 步骤 + 虚线备注」。
 */
import { ref } from 'vue';

withDefaults(
  defineProps<{
    /** 浮窗第一行的加粗标题 */
    title: string;
    /** 每条一行；序号（①②③）自己写在文字里 */
    steps?: string[];
    /** 底部虚线分隔的补充说明，一般写"不影响什么"这种边界 */
    note?: string;
    /** 内容较长的浮窗（如评分算法），宽一点 */
    wide?: boolean;
  }>(),
  { steps: () => [], note: '', wide: false },
);

let seq = 0;
const popId = `help-pop-${(seq += 1)}-${Math.random().toString(36).slice(2, 7)}`;

const root = ref<HTMLElement | null>(null);
const pop = ref<HTMLElement | null>(null);

/**
 * 浮窗是绝对定位、水平居中于「?」的，靠近视口左右边缘时会被切掉。
 * 展开前量一次宽度，把偏移量写进 --pop-shift，让浮窗和箭头一起内收。
 */
function place() {
  const marker = root.value;
  const bubble = pop.value;
  if (!marker || !bubble) return;
  const rect = marker.getBoundingClientRect();
  const width = bubble.offsetWidth;
  const center = rect.left + rect.width / 2;
  const left = Math.min(Math.max(8, center - width / 2), window.innerWidth - width - 8);
  marker.style.setProperty('--pop-shift', `${left + width / 2 - center}px`);
}

/** Esc 收起浮窗（焦点回到页面，不改变滚动位置） */
function close() {
  root.value?.blur();
}
</script>

<template>
  <!-- 挂在 <label> 里时，点击不该把焦点/弹层转给后面的控件 -->
  <span
    ref="root"
    class="help"
    tabindex="0"
    :aria-label="title"
    :aria-describedby="popId"
    @mouseenter="place"
    @focus="place"
    @keydown.esc="close"
    @click.prevent.stop="place"
  >
    ?
    <span :id="popId" ref="pop" class="help-pop" :class="{ 'help-pop-wide': wide }" role="tooltip">
      <b>{{ title }}</b>
      <slot>
        <span v-for="step in steps" :key="step" class="help-step">{{ step }}</span>
      </slot>
      <span v-if="note" class="help-note">{{ note }}</span>
    </span>
  </span>
</template>
