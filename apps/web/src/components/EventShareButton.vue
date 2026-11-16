<script setup lang="ts">
/**
 * 赛事分享按钮（赛事卡右下角）。
 *
 * 社区在 QQ 群里约局，分享的落点几乎总是"把链接或一段文案贴进群"。
 * 所以这里不做一个"分享到某平台"的按钮，而是给两件确定能用的东西：
 *   · 复制链接：只想甩个地址的时候；
 *   · 复制文案：标题、时间、报名进度都写好了，贴进群里对方一眼能判断要不要来。
 * 手机上优先走系统分享（navigator.share），失败再退回复制。
 */
import { computed, onBeforeUnmount, ref } from 'vue';
import { NButton, NPopover, useMessage } from 'naive-ui';
import type { EventView } from '../lib/api';
import { copyText } from '../lib/clipboard';
import { eventShareText, eventShareUrl } from '../lib/share';

const props = defineProps<{ event: EventView }>();

const toast = useMessage();
const open = ref(false);
/** 刚复制成功的是哪一项：按钮上短暂变成「已复制」，比只弹一个 toast 更清楚 */
const copied = ref<'link' | 'text' | null>(null);

const url = computed(() =>
  eventShareUrl(props.event.id, typeof window === 'undefined' ? '' : window.location.origin),
);
const text = computed(() => eventShareText(props.event, url.value));
/** 桌面浏览器的 Web Share 支持参差不齐，没有就干脆不显示这个入口 */
const canNativeShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

let resetTimer: number | undefined;
function markCopied(kind: 'link' | 'text') {
  copied.value = kind;
  window.clearTimeout(resetTimer);
  resetTimer = window.setTimeout(() => {
    copied.value = null;
  }, 1800);
}
// 列表页切走时组件会被卸载，别把定时器留在那儿
onBeforeUnmount(() => window.clearTimeout(resetTimer));

async function copy(kind: 'link' | 'text') {
  const ok = await copyText(kind === 'link' ? url.value : text.value);
  if (!ok) {
    toast.error('复制失败，请手动选中链接复制');
    return;
  }
  markCopied(kind);
  toast.success(kind === 'link' ? '链接已复制' : '文案已复制，直接贴进群里就行');
}

async function nativeShare() {
  try {
    await navigator.share({ title: props.event.title, text: text.value });
    open.value = false;
  } catch (err) {
    // 用户在系统面板里点了取消：什么都不做，也别复制
    if (err instanceof DOMException && err.name === 'AbortError') return;
    const ok = await copyText(text.value);
    if (ok) {
      markCopied('text');
      toast.success('文案已复制，直接贴进群里就行');
    } else {
      toast.error('分享失败，请手动复制链接');
    }
  }
}
</script>

<template>
  <NPopover
    v-model:show="open"
    trigger="click"
    placement="top-end"
    :show-arrow="true"
  >
    <template #trigger>
      <!-- 用 .btn 而不是 NButton：它和卡片里的「查看详情」是并排的一对，
           必须同高同字号；NButton 的 size="small" 会比 .btn 矮一圈 -->
      <button type="button" class="btn btn-ghost share-trigger" title="分享这场赛事">
        <svg
          viewBox="0 0 16 16"
          width="13"
          height="13"
          fill="none"
          stroke="currentColor"
          stroke-width="1.4"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <circle cx="12.2" cy="3.6" r="1.9" />
          <circle cx="3.8" cy="8" r="1.9" />
          <circle cx="12.2" cy="12.4" r="1.9" />
          <path d="M5.4 7.1 10.6 4.5M5.4 8.9l5.2 2.6" />
        </svg>
        <span>分享</span>
      </button>
    </template>

    <div class="share-pop">
      <div class="share-pop-title">分享这场赛事</div>
      <div class="share-pop-url mono">{{ url }}</div>
      <div class="share-pop-actions">
        <NButton size="small" type="primary" @click="copy('link')">
          {{ copied === 'link' ? '已复制' : '复制链接' }}
        </NButton>
        <NButton size="small" @click="copy('text')">
          {{ copied === 'text' ? '已复制' : '复制文案' }}
        </NButton>
        <NButton v-if="canNativeShare" size="small" quaternary @click="nativeShare">
          系统分享
        </NButton>
      </div>
      <p class="share-pop-hint muted">
        文案里已经写好赛事名、时间与报名进度，贴进 QQ 群即可；对方点开就是这场赛事的详情页。
      </p>
    </div>
  </NPopover>
</template>
