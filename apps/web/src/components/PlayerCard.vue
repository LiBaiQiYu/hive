<script setup lang="ts">
import { computed, ref } from 'vue';

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
    rx: (0.5 - py) * 16,
    ry: (px - 0.5) * 20,
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
}));
</script>

<template>
  <article
    ref="board"
    class="pcard"
    :class="[`pcard-${verification.tone}`, { 'is-active': tilt.active }]"
    :style="cardStyle"
    :data-skin="'basic'"
    @pointermove="onPointerMove"
    @pointerleave="onPointerLeave"
  >
    <div class="pcard-inner">
      <!-- 光斑：跟着指针走，卡片"反光"的那一下是廉价但有效的立体感来源 -->
      <div class="pcard-glare" aria-hidden="true" />
      <div class="pcard-frame" aria-hidden="true" />

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
