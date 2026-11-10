<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import CardFrameFX from './CardFrameFX.vue';
import CardLineFX from './CardLineFX.vue';
import HolographicSticker from './HolographicSticker.vue';
import RankIcon from './RankIcon.vue';
import { normalizeCardSkin, type CardSkin } from '../lib/cards';
import { renderInfinityFrame } from '../lib/infinity';
import { renderMetalFrame } from '../lib/metal';
import { renderMirrorFrame, ensureMirrorAssets } from '../lib/mirror';
import { renderPixelFrame } from '../lib/pixel';
import { renderPsiFrame } from '../lib/psi';
import { rankLabel, rankParts } from '../lib/rank';

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
  /** DOTA2 数字 ID：绑定 / 声明过才有，公开在卡片上供别人去第三方核对 */
  dotaAccountId?: number | null;
  /** Steam / STRATZ 抓来的公开头像；null 时卡片退回没有头像的布局 */
  avatarUrl?: string | null;
  /** 玩家自己选的皮肤；老接口没有这个字段时按默认皮肤渲染 */
  skin?: CardSkin | null;
}

const props = withDefaults(
  defineProps<{ player: PlayerCardData; index?: number; revision?: number }>(),
  { index: 0, revision: 0 },
);

/** rank_tier 编码：十位=勋章，个位=星级（拆解逻辑统一在 lib/rank.ts） */
const rank = computed(() => rankParts(props.player.rankTier));
/** 图标右边那句话：「传奇 3 星」；冠绝没有星级，只写「冠绝」 */
const rankText = computed(() => rankLabel(props.player.rankTier));

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

/**
 * DOTA2 数字 ID。只来自玩家主动绑定 / 声明（game_accounts），没绑定就是 null。
 * 显示它是为了"可核对"：别人可以拿去 STRATZ 看这个账号的公开段位和战绩。
 */
const dotaAccountId = computed(() => props.player.dotaAccountId ?? null);

/**
 * 头像：Steam / STRATZ 抓来的公开图。加载失败（图被删、CDN 挂了）就当没有，
 * 不要留一个破图框；地址变化时允许重新尝试。
 */
const avatarUrl = computed(() => props.player.avatarUrl ?? null);
const avatarBroken = ref(false);
watch(avatarUrl, () => {
  avatarBroken.value = false;
});

/** 皮肤只影响视觉：材质 / 边框 / 特效都是 CSS 变量，组件本身不认识具体皮肤 */
const skin = computed(() => normalizeCardSkin(props.player.skin));

/** 霜线 / 电光 / 四角走独立的 GPU 合成组件；其余边框仍由 .pcard-frame 的静态样式负责 */
const frameFx = computed<'frost' | 'spark' | 'corners' | null>(() => {
  const frame = skin.value.frame;
  return frame === 'frost' || frame === 'spark' || frame === 'corners' ? frame : null;
});

/**
 * 发丝线 / 双线换了颜色或光效时，描边交给 CardLineFX。
 * 默认的 auto + steady 不挂这一层，保持原来的原生边框（没有额外合成层）。
 */
const lineFx = computed<{
  double: boolean;
  color: CardSkin['frameColor'];
  effect: CardSkin['frameEffect'];
} | null>(() => {
  const value = skin.value;
  if (value.frame !== 'hairline' && value.frame !== 'double') return null;
  if (value.frameColor === 'auto' && value.frameEffect === 'steady') return null;
  return {
    double: value.frame === 'double',
    color: value.frameColor,
    effect: value.frameEffect,
  };
});

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
  // 边框动画的起始相位：按 index 错开，一屏十几张卡才不会像同一个转盘
  '--fx-delay': `${-((props.index % 9) * 0.97).toFixed(2)}s`,
  '--fx-delay-2': `${-((props.index % 7) * 1.43).toFixed(2)}s`,
}));

/* ---------------------------------------------------------------- 程序化卡面 */
const surfaceCanvas = ref<HTMLCanvasElement | null>(null);

let surfaceRaf = 0;
let surfaceObserver: ResizeObserver | null = null;

/** 按当前倾角重绘一帧卡面：金色走金属光照，像素走像素网格，无限镜走光廊透视 */
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
  else if (skin.value.material === 'infinity') renderInfinityFrame(canvas, w, h, opts);
  else if (skin.value.material === 'mirror') {
    // 镜面反射的是"谁的卡"：身份色相 + 段位副光 + 本人头像那盏肖像灯。
    // 场景图和头像是异步加载的，拿到之后再补一帧，别让第一帧是空板。
    const pending = ensureMirrorAssets(avatarUrl.value);
    if (pending) void pending.then(() => scheduleSurface());
    renderMirrorFrame(canvas, w, h, {
      ...opts,
      key: props.player.userId,
      rankTier: props.player.rankTier,
      avatarUrl: avatarUrl.value,
    });
  }
}

function scheduleSurface() {
  if (surfaceRaf) return;
  surfaceRaf = requestAnimationFrame(() => {
    surfaceRaf = 0;
    paintSurface();
  });
}

watch(
  // revision 是给「调整参数」弹窗用的：材质自身的可调参数不在 props 里，
  // 改完只能靠外部顶一个计数让卡片重画一帧。
  () => [skin.value.material, tilt.value.mx, tilt.value.my, props.revision],
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
    :data-line-fx="lineFx ? 'on' : undefined"
    @pointermove="onPointerMove"
    @pointerleave="onPointerLeave"
  >
    <!-- 外光晕必须放在 .pcard-inner 外面：inner 有 overflow:hidden，会被裁掉 -->
    <div v-if="frameFx" class="pcard-aura" :data-fx="frameFx" aria-hidden="true" />
    <div
      v-else-if="lineFx"
      class="pcard-aura pcard-aura--line"
      :data-color="lineFx.color"
      :data-effect="lineFx.effect"
      aria-hidden="true"
    />
    <div class="pcard-inner">
      <!-- 装饰层统一包在 .pcard-deco 里：它自带圆角裁切。
           .pcard-inner 是 preserve-3d，overflow:hidden 在 3D 上下文里不生效，
           直接放这里的话，倾斜时贴图/光斑会溢出卡片轮廓（踩过）。 -->
      <div class="pcard-deco" aria-hidden="true">
        <!-- 金色/像素/灵能/无限镜/镜面：canvas 程序化渲染，随倾斜重绘
             （无限镜的透视位移和镜面的反射都发生在这里） -->
        <canvas
          v-if="
            skin.material === 'gold' ||
            skin.material === 'pixel' ||
            skin.material === 'psi' ||
            skin.material === 'infinity' ||
            skin.material === 'mirror'
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
        <!-- 发丝线 / 双线的颜色与光效：独立描边层，只动 transform / opacity -->
        <CardLineFX
          v-if="lineFx"
          :color="lineFx.color"
          :effect="lineFx.effect"
          :double="lineFx.double"
        />
        <!-- 霜线 / 电光 / 四角：纯 CSS 合成层，只动 transform / opacity -->
        <CardFrameFX v-if="frameFx" :kind="frameFx" />
      </div>

      <header class="pcard-head">
        <div class="pcard-head-left">
          <!-- 头像来自 Steam / STRATZ 的公开资料；没有就整块不渲染，布局回到原来的样子 -->
          <img
            v-if="avatarUrl && !avatarBroken"
            class="pcard-avatar"
            :src="avatarUrl"
            alt=""
            loading="lazy"
            referrerpolicy="no-referrer"
            draggable="false"
            @error="avatarBroken = true"
          />
          <div class="pcard-head-main">
            <h3 class="pcard-name">{{ props.player.displayName }}</h3>
            <!-- 数字 ID 是公开的"可核对"入口：点开 STRATZ 能看到这个账号公开的段位与战绩。
                 @click.stop 是必需的——赛事页把整张卡包在 RouterLink 里，
                 不拦住冒泡的话点这个链接会同时跳玩家详情页。 -->
            <a
              v-if="dotaAccountId"
              class="pcard-dota mono"
              :href="`https://stratz.com/players/${dotaAccountId}`"
              target="_blank"
              rel="noopener noreferrer"
              :title="`DOTA2 数字 ID ${dotaAccountId} · 在 STRATZ 查看公开资料`"
              @click.stop
            >
              DOTA2 {{ dotaAccountId }}<span class="pcard-dota-arrow" aria-hidden="true">↗</span>
            </a>
          </div>
        </div>
        <span class="pcard-badge" :class="`badge-${verification.tone}`">
          {{ verification.label }}
        </span>
      </header>

      <div class="pcard-medal">
        <!-- 左边官方段位章（勋章 + 星星都在图里），右边补一句「传奇 3 星」 -->
        <template v-if="rank">
          <RankIcon class="pcard-medal-icon" :rank-tier="props.player.rankTier" :size="26" />
          <span class="medal-text">{{ rankText }}</span>
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
