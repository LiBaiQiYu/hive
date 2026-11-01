<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import HolographicSticker from './HolographicSticker.vue';
import { normalizeCardSkin, type CardSkin } from '../lib/cards';
import { renderMetalFrame } from '../lib/metal';
import { renderPixelFrame } from '../lib/pixel';
import { renderPsiFrame } from '../lib/psi';

export interface PlayerCardData {
  userId: string;
  status: string;
  displayName: string;
  bio: string | null;
  position: number | null;
  rankTier: number | null;
  declaredMmr: number | null;
  rating: number | null;
  verification: string;
  personaName: string | null;
  /** 玩家自己选的皮肤；老接口没有这个字段时按默认皮肤渲染 */
  skin?: CardSkin | null;
}

const props = withDefaults(defineProps<{ player: PlayerCardData; index?: number }>(), {
  index: 0,
});

const MEDALS: Record<number, string> = {
  1: '先锋',
  2: '卫士',
  3: '中军',
  4: '统帅',
  5: '传奇',
  6: '万古流芳',
  7: '超凡入圣',
  8: '冠绝',
};

/** rank_tier 编码：十位=勋章，个位=星级 */
const rank = computed(() => {
  const tier = props.player.rankTier;
  if (!tier || tier < 10) return null;
  const medal = Math.floor(tier / 10);
  const star = tier % 10;
  return { medal: MEDALS[medal] ?? '未知', star, tier };
});

const verification = computed(() => {
  switch (props.player.verification) {
    case 'VERIFIED':
      return { label: 'Steam 已认证', tone: 'ok' };
    case 'VERIFIED_NO_DATA':
      return { label: '已验证 · 段位未公开', tone: 'info' };
    case 'CLAIMED':
      return { label: '归属未验证', tone: 'warn' };
    default:
      return { label: '自报', tone: 'idle' };
  }
});

const mmrLabel = computed(() =>
  props.player.declaredMmr === null ? '—' : String(props.player.declaredMmr),
);

/** 皮肤只影响视觉：材质 / 边框 / 特效都是 CSS 变量，组件本身不认识具体皮肤 */
const skin = computed(() => normalizeCardSkin(props.player.skin));

/* ---------------------------------------------------------------- 3D 倾斜 */

const board = ref<HTMLElement | null>(null);
const tilt = ref({ rx: 0, ry: 0, mx: 50, my: 50, active: false });

/**
 * 指针位置 → 卡片姿态。
 * 角度上限刻意压到 16°/20°：超过这个量文字就开始糊，卡片感会变成"晃动的图片"。
 */
function onPointerMove(event: PointerEvent) {
  if (event.pointerType === 'touch') return;
  const node = board.value;
  if (!node) return;

  const rect = node.getBoundingClientRect();
  const px = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  const py = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));

  tilt.value = {
    rx: (0.5 - py) * 22,
    ry: (px - 0.5) * 26,
    mx: px * 100,
    my: py * 100,
    active: true,
  };
}

function onPointerLeave() {
  tilt.value = { rx: 0, ry: 0, mx: 50, my: 50, active: false };
}

const cardStyle = computed(() => ({
  '--rx': `${tilt.value.rx.toFixed(2)}deg`,
  '--ry': `${tilt.value.ry.toFixed(2)}deg`,
  '--mx': `${tilt.value.mx}%`,
  '--my': `${tilt.value.my}%`,
  // 归一化到 -1..1：材质贴图用它做视差位移，指针在中心时正好是 0
  '--px': `${((tilt.value.mx - 50) / 50).toFixed(3)}`,
  '--py': `${((tilt.value.my - 50) / 50).toFixed(3)}`,
}));

/* ---------------------------------------------------------------- 程序化卡面 */
const surfaceCanvas = ref<HTMLCanvasElement | null>(null);

let surfaceRaf = 0;
let surfaceObserver: ResizeObserver | null = null;

/** 按当前倾角重绘一帧卡面：金色走金属光照，像素走像素网格 */
function paintSurface() {
  const canvas = surfaceCanvas.value;
  if (!canvas) return;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return;
  const opts = { tiltX: (tilt.value.mx - 50) / 50, tiltY: (tilt.value.my - 50) / 50 };
  if (skin.value.material === 'gold') renderMetalFrame(canvas, w, h, opts);
  else if (skin.value.material === 'pixel') renderPixelFrame(canvas, w, h, opts);
  else if (skin.value.material === 'psi') renderPsiFrame(canvas, w, h, opts);
}

function scheduleSurface() {
  if (surfaceRaf) return;
  surfaceRaf = requestAnimationFrame(() => {
    surfaceRaf = 0;
    paintSurface();
  });
}

watch(
  () => [skin.value.material, tilt.value.mx, tilt.value.my],
  () => {
    // canvas 是 v-if 出来的：挂载后要重新 observe，才能拿到第一帧的尺寸
    const canvas = surfaceCanvas.value;
    if (canvas && surfaceObserver) surfaceObserver.observe(canvas);
    scheduleSurface();
  },
  { flush: 'post' },
);

onMounted(() => {
  surfaceObserver = new ResizeObserver(scheduleSurface);
  if (board.value) surfaceObserver.observe(board.value);
  if (surfaceCanvas.value) surfaceObserver.observe(surfaceCanvas.value);
  scheduleSurface();
});

onBeforeUnmount(() => {
  if (surfaceRaf) cancelAnimationFrame(surfaceRaf);
  surfaceObserver?.disconnect();
  surfaceObserver = null;
});
</script>

<template>
  <article
    ref="board"
    class="pcard"
    :class="[`pcard-${verification.tone}`, { 'is-active': tilt.active }]"
    :style="cardStyle"
    :data-material="skin.material"
    :data-frame="skin.frame"
    @pointermove="onPointerMove"
    @pointerleave="onPointerLeave"
  >
    <div class="pcard-inner">
      <!-- 装饰层统一包在 .pcard-deco 里：它自带圆角裁切。
           .pcard-inner 是 preserve-3d，overflow:hidden 在 3D 上下文里不生效，
           直接放这里的话，倾斜时贴图/光斑会溢出卡片轮廓（踩过）。 -->
      <div class="pcard-deco" aria-hidden="true">
        <!-- 金色/像素：canvas 程序化渲染（金属光照 / 像素网格），随倾斜重绘 -->
        <canvas
          v-if="
            skin.material === 'gold' || skin.material === 'pixel' || skin.material === 'psi'
          "
          ref="surfaceCanvas"
          class="pcard-surface"
        />
        <!-- 全息走独立组件：五层贴纸结构（底板/薄膜/切面/高光/树脂）自带一套 -->
        <HolographicSticker
          v-if="skin.material === 'holo'"
          surface
          :rim="false"
          :interactive="true"
          :intensity="0.95"
          :tilt-x="(tilt.mx - 50) / 50"
          :tilt-y="(tilt.my - 50) / 50"
        />
        <template v-if="skin.material !== 'holo'">
          <!-- 材质纹理 + 边框/特效的公共图层；纯装饰，不参与布局 -->
          <div class="pcard-fx" />
          <!-- 视差层：材质把自己的图案再画一两层，随卡片角度错位移动 -->
          <div class="pcard-depth" />
        </template>
        <!-- 光斑：跟着指针走，卡片"反光"的那一下是廉价但有效的立体感来源 -->
        <div class="pcard-glare" />
        <div class="pcard-frame" />
      </div>

      <header class="pcard-head">
        <h3 class="pcard-name">{{ props.player.displayName }}</h3>
        <span class="pcard-badge" :class="`badge-${verification.tone}`">
          {{ verification.label }}
        </span>
      </header>

      <div class="pcard-medal">
        <template v-if="rank">
          <span class="medal-text">{{ rank.medal }}</span>
          <span class="medal-star">
            <i v-for="n in Math.max(rank.star, 0)" :key="n">★</i>
          </span>
        </template>
        <span v-else class="medal-none">未公开段位</span>
      </div>

      <dl class="pcard-stats">
        <div>
          <dt>WARROOM</dt>
          <dd class="mono">{{ props.player.rating ?? '—' }}</dd>
        </div>
        <div>
          <dt>天梯 MMR</dt>
          <dd class="mono">{{ mmrLabel }}</dd>
        </div>
        <div>
          <dt>位置</dt>
          <dd class="mono">{{ props.player.position ? `${props.player.position} 号位` : '未填' }}</dd>
        </div>
      </dl>

      <p v-if="props.player.bio" class="pcard-bio">{{ props.player.bio }}</p>
      <p v-else class="pcard-bio pcard-bio-empty">这家伙很懒，没写简介</p>

      <footer class="pcard-foot">
        <span v-if="props.player.status === 'WAITLIST'" class="pcard-wait">候补</span>
        <span v-else class="pcard-wait pcard-confirmed">正选</span>
        <span v-if="props.player.personaName" class="pcard-steam mono">
          Steam · {{ props.player.personaName }}
        </span>
      </footer>
    </div>
  </article>
</template>
