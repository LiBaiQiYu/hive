<script setup lang="ts">
/**
 * 我的主页：玩家档案，不是设置页。
 *
 * 四块内容 = 别人眼里的你 + 你能马上改的东西：
 *   WARROOM 评分 / 游戏身份 / 卡片外观 / 位置偏好。
 * 资料和密码这类低频表单搬去 /settings，入口在右上角用户名下拉里。
 */
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import CardStudio from '../components/CardStudio.vue';
import type { PlayerCardData } from '../components/PlayerCard.vue';
import GameIdentityCard from '../components/me/GameIdentityCard.vue';
import PositionEditor from '../components/me/PositionEditor.vue';
import RatingCard from '../components/me/RatingCard.vue';
import { DEFAULT_CARD_SKIN, normalizeCardSkin, type CardSkin } from '../lib/cards';
import { ApiError, api } from '../lib/api';
import { loadMe, session } from '../lib/session';

import HelpTip from '../components/HelpTip.vue';

const loading = ref(true);

onMounted(async () => {
  if (!session.ready) await loadMe();
  loading.value = false;
});

/* ---------------------------------------------------------------- 卡片外观 */
const cardSkin = ref<CardSkin>({ ...DEFAULT_CARD_SKIN });
const cardSkinSaving = ref(false);
const cardSkinStatus = ref('');
let cardSkinTimer: number | undefined;

watch(
  () => session.me?.cardSkin,
  (skin) => {
    if (skin) cardSkin.value = normalizeCardSkin(skin);
  },
  { deep: true, immediate: true },
);

/**
 * 点一下就要有反馈：本地立刻换装，350ms 内的连续点击合并成一次请求。
 * 皮肤是整份提交（四个字段一起写），不做"只改一半"的局部更新。
 */
function onCardSkinChange(next: CardSkin) {
  cardSkin.value = next;
  cardSkinStatus.value = '';
  window.clearTimeout(cardSkinTimer);
  cardSkinTimer = window.setTimeout(() => void saveCardSkin(), 350);
}

async function saveCardSkin() {
  cardSkinSaving.value = true;
  try {
    await api('/me/card-skin', { method: 'PUT', body: cardSkin.value });
    // 不重新拉 /me：那会把刚点的选择回滚成服务端旧值，直接写回本地会话即可
    if (session.me) session.me.cardSkin = { ...cardSkin.value };
    cardSkinStatus.value = '已保存';
  } catch (err) {
    cardSkinStatus.value = err instanceof ApiError ? err.message : '保存失败';
  } finally {
    cardSkinSaving.value = false;
  }
}

/** 预览用的"我"：字段和报名名单里的玩家卡完全一致，所见即所得 */
const previewPlayer = computed<PlayerCardData>(() => {
  const me = session.me;
  const topPosition = me?.positions.find((item) => item.rank === 1)?.position ?? null;
  const rankTier = me?.stats?.rankTier ?? null;
  const accountVerification = me?.gameAccount?.verification ?? null;
  let verification = 'SELF_REPORTED';
  if (accountVerification === 'VERIFIED') {
    verification = rankTier !== null ? 'VERIFIED' : 'VERIFIED_NO_DATA';
  } else if (accountVerification === 'CLAIMED') {
    verification = 'CLAIMED';
  }

  return {
    userId: me?.user.id ?? 'preview',
    status: 'CONFIRMED',
    displayName: me?.user.displayName || '你的名字',
    bio: me?.user.bio ?? null,
    position: topPosition,
    rankTier,
    declaredMmr: me?.stats?.declaredMmr ?? null,
    rating: me?.rating?.effective ?? null,
    verification,
    personaName: me?.gameAccount?.personaName ?? null,
    skin: cardSkin.value,
  };
});
</script>

<template>
  <div class="container">
    <div class="section-head me-head">
      <h1 class="section-title">我的主页</h1>
      <div v-if="session.me" class="me-head-actions">
        <span class="muted" style="font-size: 13px">
          {{ session.me.user.displayName }} · @{{ session.me.user.username }}
        </span>
        <RouterLink to="/settings#profile" class="btn">编辑资料</RouterLink>
      </div>
    </div>

    <div v-if="loading" class="empty">加载中…</div>

    <div v-else-if="!session.me" class="empty">
      请先 <RouterLink to="/login" style="color: var(--gold-2)">登录</RouterLink>。
    </div>

    <template v-else>
      <div class="grid grid-2">
        <RatingCard />
        <GameIdentityCard />
      </div>

      <!-- 卡片外观：材质 / 边框 / 特效，独立成板块 -->
      <section id="card-style" class="card section">
        <h2 class="card-title">
          卡片外观
          <HelpTip
            wide
            title="这些皮肤会出现在哪？"
            :steps="[
              '① 报名名单里的玩家卡就是这张，别人看到的是你自己选的那套',
              '② 材质、边框、特效可以任意组合，点了就自动保存',
              '③ 只影响外观：评分、段位、位置与分队结果一律不变',
            ]"
            note="特效是纯 CSS 动画，只动 transform / opacity；系统开启「减少动态效果」时会自动静止。触屏上没有 3D 倾斜，别再给卡片加抖动。"
          />
        </h2>

        <CardStudio
          :player="previewPlayer"
          :model-value="cardSkin"
          :saving="cardSkinSaving"
          :status="cardSkinStatus"
          @update:model-value="onCardSkinChange"
        />
      </section>

      <!-- 位置偏好：显式保存，离开前会拦一次未保存的改动 -->
      <PositionEditor />
    </template>
  </div>
</template>
