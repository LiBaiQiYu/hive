<script setup lang="ts">
/**
 * 我的主页：玩家档案，不是设置页。
 *
 * 四块内容 = 别人眼里的你 + 你能马上改的东西：
 *   WARROOM 评分 / 游戏身份 / 卡片外观 / 位置偏好。
 * 资料和密码这类低频表单搬去 /settings，入口在右上角用户名下拉里。
 */
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { useMessage } from 'naive-ui';
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
const route = useRoute();
const router = useRouter();
const message = useMessage();

/**
 * Steam 绑定走的是整页跳转（Steam → 本站 /me?steam=…），SPA 的会话是内存态，
 * 回到这个页面时其实是一次全新的加载。**必须把结果读出来告诉用户**：
 * 之前没有任何处理，校验失败时人只会被安静地送回 /me，看起来就是"点了没反应"。
 */
const STEAM_ERROR_TEXT: Record<string, string> = {
  state: '绑定校验已过期，或发起绑定与回到本站用的不是同一个地址（Cookie 不通用）。请重新点一次；地址栏要用 APP_ORIGIN 里的那个地址',
  return_to: '回调地址与本站配置的 APP_ORIGIN 不一致，请检查部署配置',
  endpoint: 'Steam 返回的端点不对，请重新绑定',
  claimed_id: 'Steam 没有返回有效的 17 位账号 ID，请重新绑定',
  post_failed: '服务器无法访问 steamcommunity.com 做反向校验，请检查出网后再试',
  not_valid: 'Steam 判定这次校验无效（通常已过期），请重新绑定',
  taken: '这个 Steam 账号已经绑定了另一个 HIVE 账号，请先在那边解绑',
  verify: 'Steam 校验没通过，请重新绑定',
};

/** 读 ?steam= 的结果、弹出提示，然后把参数从地址栏抹掉（否则刷新会重放同一句提示） */
async function handleSteamResult() {
  const result = route.query.steam;
  if (typeof result !== 'string') return;

  if (result === 'linked') {
    message.success('Steam 绑定成功，段位会在几秒内由 STRATZ 拉取');
  } else {
    const reason = typeof route.query.reason === 'string' ? route.query.reason : 'verify';
    message.error(STEAM_ERROR_TEXT[reason] ?? `Steam 绑定失败（reason=${reason}）`, {
      duration: 8000,
    });
  }

  const query = { ...route.query };
  delete query.steam;
  delete query.reason;
  await router.replace({ path: route.path, query, hash: route.hash });
}

onMounted(async () => {
  // 带着绑定结果回来时一定要重新拉 /me：内存里的旧会话会把刚绑上的账号盖成"未绑定"
  if (!session.ready || typeof route.query.steam === 'string') await loadMe();
  loading.value = false;
  await handleSteamResult();
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
    // 预览也要带头像，否则"卡片外观"看到的是无头像版，和别人看到的不一致
    avatarUrl: me?.gameAccount?.avatarUrl ?? null,
    dotaAccountId: me?.gameAccount?.dotaAccountId ?? null,
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
        <!-- 别人眼里的你：和从排行榜点进来的是同一个页面 -->
        <RouterLink
          :to="`/players/${session.me.user.id}`"
          class="btn"
          title="别人在排行榜点你时看到的样子"
        >
          公开主页
        </RouterLink>
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
          :founder="session.me?.user.founder === true"
          @update:model-value="onCardSkinChange"
        />
      </section>

      <!-- 位置偏好：显式保存，离开前会拦一次未保存的改动 -->
      <PositionEditor />
    </template>
  </div>
</template>
