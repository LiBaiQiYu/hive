<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import { NButton, NInput, NInputNumber, NPopconfirm, NSelect, useMessage } from 'naive-ui';
import HelpTip from '../components/HelpTip.vue';
import CardStudio from '../components/CardStudio.vue';
import type { PlayerCardData } from '../components/PlayerCard.vue';
import { DEFAULT_CARD_SKIN, normalizeCardSkin, type CardSkin } from '../lib/cards';
import { ApiError, api, formatDate } from '../lib/api';
import { loadMe, session } from '../lib/session';

interface Slot {
  position: number;
  rank: number;
  proficiency: number;
}

const POSITION_NAMES: Record<number, string> = {
  1: '1 号位 · 优势路核心',
  2: '2 号位 · 中路',
  3: '3 号位 · 劣势路',
  4: '4 号位 · 游走辅助',
  5: '5 号位 · 保人辅助',
};

const slots = ref<Slot[]>([
  { position: 1, rank: 0, proficiency: 60 },
  { position: 2, rank: 0, proficiency: 60 },
  { position: 3, rank: 0, proficiency: 60 },
  { position: 4, rank: 0, proficiency: 60 },
  { position: 5, rank: 0, proficiency: 60 },
]);

const loading = ref(true);
const saving = ref(false);
const error = ref('');
const saved = ref(false);
const message = useMessage();

/** 志愿下拉：已被别的位置占用的档位不再出现，避免"选完再报错" */
function rankSelectOptions(slot: Slot) {
  return [0, 1, 2, 3, 4, 5]
    .filter((rank) => rank === 0 || rank === slot.rank || !usedRanks.value.has(rank))
    .map((rank) => ({ label: rank === 0 ? '不打' : `第 ${rank} 志愿`, value: rank }));
}

function fillFromProfile(positions: { position: number; rank: number; proficiency: number }[]) {
  slots.value = [1, 2, 3, 4, 5].map((position) => {
    const found = positions.find((item) => item.position === position);
    return {
      position,
      rank: found?.rank ?? 0,
      proficiency: found?.proficiency ?? 60,
    };
  });
}

onMounted(async () => {
  if (!session.ready) await loadMe();
  fillFromProfile(session.me?.positions ?? []);
  void loadRatingHistory();
  loading.value = false;
});

// 切换账号或刷新后重新填充
watch(
  () => session.me?.positions,
  (positions) => fillFromProfile(positions ?? []),
  { deep: true },
);

/** 已被占用的志愿，用于禁止重复选择 */
const usedRanks = computed(() => new Set(slots.value.filter((s) => s.rank > 0).map((s) => s.rank)));

function rankOptions(slot: Slot): number[] {
  return [0, 1, 2, 3, 4, 5].filter(
    (rank) => rank === 0 || rank === slot.rank || !usedRanks.value.has(rank),
  );
}

const chosen = computed(() => slots.value.filter((s) => s.rank > 0).sort((a, b) => a.rank - b.rank));

/** 志愿必须从 1 连续递增，和后端规则保持一致 */
const contiguous = computed(() =>
  chosen.value.every((slot, index) => slot.rank === index + 1),
);

const canSave = computed(() => contiguous.value && !saving.value);

const rating = computed(() => session.me?.rating ?? null);
const account = computed(() => session.me?.gameAccount ?? null);

/* ---------------------------------------------------------------- 资料编辑 */
const profile = ref({ displayName: '', bio: '', qqNumber: '' });
const profileSaving = ref(false);
const profileError = ref('');
const profileSaved = ref(false);

function fillProfile() {
  const user = session.me?.user;
  profile.value = {
    displayName: user?.displayName ?? '',
    bio: user?.bio ?? '',
    qqNumber: user?.qqNumber ?? '',
  };
}

watch(() => session.me?.user, fillProfile, { deep: true, immediate: true });

async function saveProfile() {
  profileSaving.value = true;
  profileError.value = '';
  profileSaved.value = false;
  try {
    await api('/me', {
      method: 'PATCH',
      body: {
        displayName: profile.value.displayName,
        bio: profile.value.bio || null,
        qqNumber: profile.value.qqNumber || null,
      },
    });
    await loadMe();
    profileSaved.value = true;
    message.success('资料已保存');
  } catch (err) {
    profileError.value = err instanceof ApiError ? err.message : '保存失败';
  } finally {
    profileSaving.value = false;
  }
}

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
 * 皮肤是整份提交（三个字段一起写），不做"只改一半"的局部更新。
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

/* ---------------------------------------------------------------- 手动段位 */
const MEDALS = ['先锋', '卫士', '中军', '统帅', '传奇', '万古流芳', '超凡入圣', '冠绝'];
const MEDAL_FLOORS = [0, 770, 1540, 2310, 3080, 3850, 4620, 5420];
const medalOptions = MEDALS.map((name, index) => ({ label: name, value: index + 1 }));
const starOptions = [1, 2, 3, 4, 5].map((s) => ({ label: `${s} 星`, value: s }));
const rankForm = ref({ medal: 4, star: 1, mmr: null as number | null });
const rankSaving = ref(false);
const rankMsg = ref('');
const rankErr = ref('');

/**
 * MMR → 勋章/星级，与服务端 rankTierFromMmr 保持一致。
 * 前端这份只用于即时预览，服务端始终以天梯分为准重新折算，所以即使有偏差也不会存错。
 */
const rankFromMmr = (mmr: number): { medal: number; star: number } => {
  if (mmr >= 5420) return { medal: 8, star: 0 };
  let medal = 1;
  for (let m = 7; m >= 1; m -= 1) {
    if (mmr >= (MEDAL_FLOORS[m - 1] ?? 0)) {
      medal = m;
      break;
    }
  }
  const floor = MEDAL_FLOORS[medal - 1] ?? 0;
  const star = Math.min(5, Math.max(1, 1 + Math.floor((mmr - floor) / 154)));
  return { medal, star };
}

/** 填了天梯分就锁定段位选择，并由分数反推显示 */
const derivedRank = computed(() =>
  rankForm.value.mmr !== null && rankForm.value.mmr > 0 ? rankFromMmr(rankForm.value.mmr) : null,
);

watch(derivedRank, (derived) => {
  if (!derived) return;
  rankForm.value.medal = derived.medal;
  rankForm.value.star = derived.star;
});

/** 同步来的段位（OpenDota 只给勋章+星，没有 MMR） */
const rankLabel = computed(() => {
  const tier = session.me?.stats?.rankTier;
  if (!tier) return '未采集';
  const medal = Math.floor(tier / 10);
  const star = tier % 10;
  const name = MEDALS[medal - 1] ?? '未知';
  return medal === 8 ? name : `${name} ${star} 星`;
});

const rankSourceLabel = computed(() => {
  const source = session.me?.stats?.rankSource;
  if (source === 'OPENDOTA') return 'OpenDota';
  if (source === 'STRATZ') return 'STRATZ';
  if (source === 'SELF_REPORTED') return '手动填写';
  if (source === 'ADMIN_SET') return '管理员设定';
  return null;
});

// 表单初值跟随已同步的数据，避免"库里是万古流芳、表单显示统帅"
watch(
  () => session.me?.stats,
  (stats) => {
    if (!stats?.rankTier) return;
    rankForm.value.medal = Math.floor(stats.rankTier / 10);
    rankForm.value.star = stats.rankTier % 10 || 1;
    // 只有"自报段位"才回填 MMR；同步来的段位下 MMR 已被清空，不该再显示旧数字
    rankForm.value.mmr = stats.rankSource === 'SELF_REPORTED' ? (stats.declaredMmr ?? null) : null;
  },
  { immediate: true },
);

async function saveRank() {
  rankSaving.value = true;
  rankErr.value = '';
  rankMsg.value = '';
  try {
    // rank_tier = 勋章 × 10 + 星级，例如 中军2 = 32、统帅5 = 45；冠绝 = 80（无星级）
    const rankTier = rankForm.value.medal === 8 ? 80 : rankForm.value.medal * 10 + rankForm.value.star;

    // 天梯分留空时 v-model.number 会给出 ''（不是 null），直接传会被服务端判为非法类型
    const mmr =
      typeof rankForm.value.mmr === 'number' && rankForm.value.mmr > 0
        ? Math.round(rankForm.value.mmr)
        : null;

    const result = await api<{ rating: { effective: number } }>('/me/rank', {
      method: 'PUT',
      body: { rankTier, declaredMmr: mmr },
    });
    await loadMe();
    rankMsg.value = `已保存，WARROOM 评分更新为 ${result.rating.effective}`;
    message.success('段位已保存');
  } catch (err) {
    rankErr.value = err instanceof ApiError ? err.message : '保存失败';
  } finally {
    rankSaving.value = false;
  }
}

/* ---------------------------------------------------------------- OpenDota 拉段位 */
const accountForm = ref({ id: null as number | null });
const claiming = ref(false);
const claimMsg = ref('');
const claimErr = ref('');

async function claimAccount() {
  if (!accountForm.value.id) {
    claimErr.value = '请填写数字 ID，例如 109902856';
    return;
  }
  claiming.value = true;
  claimErr.value = '';
  claimMsg.value = '';
  try {
    const result = await api<{
      personaName: string | null;
      rankTier: number | null;
      hiddenData: boolean;
      rating: { effective: number };
    }>('/me/game-account/claim', {
      method: 'POST',
      body: { accountId: accountForm.value.id },
    });
    await loadMe();
    claimMsg.value = result.hiddenData
      ? `${result.personaName ?? '该账号'} 没有公开段位，请在 Dota2 里开启「公开比赛数据」，或手动填写段位`
      : `已同步 ${result.personaName ?? ''} 的段位（${result.rankTier ? `${MEDALS[Math.floor(result.rankTier / 10) - 1] ?? ''} ${result.rankTier % 10} 星` : ''}），评分更新为 ${result.rating.effective}`;
    message.success('已从 OpenDota 同步');
  } catch (err) {
    claimErr.value = err instanceof ApiError ? err.message : '获取失败';
  } finally {
    claiming.value = false;
  }
}

/* ---------------------------------------------------------------- Steam 解绑 / 重新认证 */
const steamBusy = ref(false);

/** 解绑会删掉 game_accounts 整行，段位来源随之失效 */
async function unbindSteam() {
  steamBusy.value = true;
  try {
    await api('/auth/steam/unlink', { method: 'DELETE' });
    await loadMe();
    message.success('已解绑 Steam，可以重新认证');
  } catch (err) {
    message.error(err instanceof ApiError ? err.message : '解绑失败');
  } finally {
    steamBusy.value = false;
  }
}

/** 重新认证 = 先解绑再跳 Steam：否则唯一索引会挡住新的绑定 */
async function rebindSteam() {
  steamBusy.value = true;
  try {
    await api('/auth/steam/unlink', { method: 'DELETE' }).catch(() => undefined);
    window.location.href = '/api/auth/steam/start';
  } catch (err) {
    message.error(err instanceof ApiError ? err.message : '跳转失败');
    steamBusy.value = false;
  }
}

/* ---------------------------------------------------------------- 评分调整记录 */
interface RatingHistoryRow {
  id: string;
  oldAdjustment: number;
  newAdjustment: number;
  oldEffective: number;
  newEffective: number;
  reason: string;
  createdAt: number;
  operatorName: string | null;
}

const ratingHistory = ref<RatingHistoryRow[]>([]);

async function loadRatingHistory() {
  try {
    const data = await api<{ history: RatingHistoryRow[] }>('/me/rating-history');
    ratingHistory.value = data.history;
  } catch {
    ratingHistory.value = [];
  }
}

const signed = (n: number) => `${n >= 0 ? '+' : ''}${n}`;

/* ---------------------------------------------------------------- 修改密码 */
const pwd = ref({ current: '', next: '', confirm: '' });
const pwdSaving = ref(false);
const pwdError = ref('');
const pwdMsg = ref('');

async function changePassword() {
  pwdError.value = '';
  pwdMsg.value = '';
  if (pwd.value.next.length < 10) {
    pwdError.value = '新密码至少 10 位';
    return;
  }
  if (pwd.value.next !== pwd.value.confirm) {
    pwdError.value = '两次输入的新密码不一致';
    return;
  }
  pwdSaving.value = true;
  try {
    await api('/auth/password', {
      method: 'POST',
      body: { currentPassword: pwd.value.current, newPassword: pwd.value.next },
    });
    pwd.value = { current: '', next: '', confirm: '' };
    pwdMsg.value = '密码已修改。其他设备上的登录已失效，这台保持在线。';
    message.success('密码已修改');
  } catch (err) {
    pwdError.value = err instanceof ApiError ? err.message : '修改失败';
  } finally {
    pwdSaving.value = false;
  }
}

async function save() {
  saving.value = true;
  error.value = '';
  saved.value = false;
  try {
    await api('/me/positions', {
      method: 'PUT',
      body: chosen.value.map((slot) => ({
        position: slot.position,
        rank: slot.rank,
        proficiency: slot.proficiency,
      })),
    });
    await loadMe();
    saved.value = true;
    message.success('位置偏好已保存');
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '保存失败';
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="container" style="max-width: 980px">
    <div class="section-head">
      <h1 class="section-title">我的</h1>
      <span v-if="session.me" class="muted" style="font-size: 13px">
        {{ session.me.user.displayName }} · @{{ session.me.user.username }}
      </span>
    </div>

    <div v-if="loading" class="empty">加载中…</div>

    <div v-else-if="!session.me" class="empty">
      请先 <RouterLink to="/login" style="color: var(--gold-2)">登录</RouterLink>。
    </div>

    <template v-else>
      <div class="grid grid-2">
        <!-- 评分 -->
        <section class="card">
          <h2 class="card-title">
            WARROOM Rating
            <HelpTip
              wide
              title="这个分怎么算的？"
              :steps="[
                '① 范围 0–1000，是分队用的内部值，和天梯 MMR 不是一回事',
                '② 段位 900：天梯勋章与 MMR，几乎决定全部实力判断',
                '③ 社区出勤 100：报名后是否到场，报了不来按缺席比例扣分',
                '④ 样本不足时向 500 收缩，新人不会因为两三局连胜就虚高',
              ]"
              note="战绩、英雄池、位置能力都不进评分（位置属于分队逻辑）。管理员可修正，必须填原因且不可删除，幅度随数据可信度放宽到 ±500。报名与分组时冻结快照，改评分不影响已公布的阵容。"
            />
          </h2>

          <template v-if="rating">
            <div class="rating-hero">
              <div class="rating-score mono">{{ rating.effective }}</div>
              <div class="rating-pm mono">± {{ rating.uncertainty }}</div>
            </div>

            <div class="rating-split">
              <div>
                <div class="stat-label">系统评分</div>
                <div class="mono">{{ rating.system }}</div>
              </div>
              <div>
                <div class="stat-label">管理员修正</div>
                <div class="mono">
                  {{ rating.adjustment >= 0 ? '+' : '' }}{{ rating.adjustment }}
                </div>
              </div>
              <div>
                <div class="stat-label">数据置信度</div>
                <div class="mono">{{ (rating.confidenceBp / 100).toFixed(0) }}%</div>
              </div>
            </div>

            <!-- 评分构成：段位与出勤各贡献多少分 -->
            <div v-if="rating.breakdown" class="rating-break">
              <div class="rating-break-title">系统分构成</div>
              <div v-for="part in rating.breakdown.components" :key="part.key" class="rating-break-row">
                <span class="rating-break-name">
                  {{ part.key === 'RANK' ? '段位' : '社区出勤' }}
                </span>
                <div class="rating-break-bar">
                  <i :style="{ width: `${Math.round(part.value * 100)}%` }"></i>
                </div>
                <span class="rating-break-score mono">{{ part.score }}<span class="muted"> / {{ part.weight }}</span></span>
              </div>
              <p class="rating-break-note muted">
                <template v-if="typeof rating.breakdown.attendanceBp === 'number'">
                  出勤率 {{ (rating.breakdown.attendanceBp / 100).toFixed(0) }}% ·
                </template>
                <template v-else>还没有已结束的赛事，出勤按满分计 ·</template>
                <template v-if="typeof rating.breakdown.estimatedMmr === 'number'">
                  估算 MMR {{ rating.breakdown.estimatedMmr }}
                </template>
                <template v-else>缺少段位数据，按中性值计</template>
              </p>
            </div>

            <details v-if="ratingHistory.length > 0" class="explainer">
              <summary>评分调整记录（{{ ratingHistory.length }}）</summary>
              <div class="explainer-body">
                <div v-for="item in ratingHistory" :key="item.id" class="rating-history-row">
                  <span class="muted">{{ formatDate(item.createdAt) }}</span>
                  <span class="mono">
                    {{ signed(item.oldAdjustment) }} → {{ signed(item.newAdjustment) }}
                  </span>
                  <span class="mono">最终 {{ item.newEffective }}</span>
                  <span class="muted">{{ item.operatorName ?? '—' }}</span>
                  <span class="rating-history-reason">{{ item.reason }}</span>
                </div>
              </div>
            </details>

          </template>

          <p v-else class="muted" style="margin: 0">
            还没有评分记录。绑定 Steam 或填写段位后，管理员可以为你设定初始评分。
          </p>
        </section>

        <!-- 身份 -->
        <section class="card">
          <h2 class="card-title">
            游戏身份
            <HelpTip
              wide
              title="身份怎么验证？"
              :steps="[
                '① Steam 登录只是跳转到 Steam 官方页面确认身份，本站接触不到你的密码',
                '② 不绑定也能用：手动填段位同样计入评分，只是归属显示「未验证」',
                '③ 数字 ID 只证明这个账号存在且有公开数据，不能证明它是你的',
              ]"
              note="归属验证只有 Steam 能给。解绑会删掉 Steam 归属验证和同步来的段位，之后可以重新绑定。"
            />
          </h2>

          <div v-if="account" class="id-row">
            <span
              class="pill"
              :class="account.verification === 'VERIFIED' ? 'pill-open' : 'pill-closed'"
            >
              {{ account.verification === 'VERIFIED' ? '✓ Steam 已认证' : '数据已校验 · 归属未验证' }}
            </span>
            <span class="mono">DOTA ID {{ account.dotaAccountId }}</span>
          </div>

          <div v-if="account" class="id-row">
            <span class="stat-label">游戏昵称</span>
            <span class="mono">{{ account.personaName ?? '—' }}</span>
          </div>

          <div v-if="account" class="id-row">
            <span class="stat-label">同步段位</span>
            <span class="mono" :style="rankLabel === '未采集' ? 'color: var(--amber)' : ''">
              {{ rankLabel }}
              <span v-if="rankSourceLabel" class="muted" style="font-size: 11px">
                · {{ rankSourceLabel }}
              </span>
            </span>
          </div>

          <div v-if="account" class="id-row">
            <span class="stat-label">天梯分</span>
            <span class="mono">
              {{ session.me?.stats?.declaredMmr ?? '未采集' }}
              <span class="muted" style="font-size: 11px">
                <template
                  v-if="
                    session.me?.stats?.declaredMmr &&
                    session.me?.stats?.rankSource !== 'SELF_REPORTED'
                  "
                >
                  （已忽略，当前以同步段位为准）
                </template>
                <template v-else>（OpenDota 不提供 MMR，需手动填）</template>
              </span>
            </span>
          </div>
          <div class="id-row">
            <span class="stat-label">归属验证</span>
            <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap">
              <span v-if="account?.verification === 'VERIFIED'" class="pill pill-open">✓ Steam 已验证</span>
              <span v-else class="muted" style="font-size: 13px">未验证</span>

              <a
                v-if="account?.verification !== 'VERIFIED'"
                class="btn"
                href="/api/auth/steam/start"
                title="跳转到 Steam 官方页面确认身份，本站接触不到你的密码"
              >
                绑定 Steam
              </a>

              <template v-else>
                <NButton :disabled="steamBusy" :loading="steamBusy" @click="rebindSteam">
                  重新认证
                </NButton>
                <NPopconfirm @positive-click="unbindSteam">
                  <template #trigger>
                    <NButton :disabled="steamBusy">解绑</NButton>
                  </template>
                  解绑会删除 Steam 归属验证和同步来的段位数据，之后可以重新绑定。确定解绑吗？
                </NPopconfirm>
              </template>
            </div>
          </div>

          <div
            v-if="account?.verification !== 'VERIFIED'"
            style="padding: 12px 0; border-bottom: 1px dashed var(--line)"
          >
            <div class="field-label" style="margin-bottom: 8px">
              用数字 ID 获取段位（免 Steam）
              <HelpTip
                title="数字 ID 从哪来？"
                :steps="[
                  '① 打开 Dota2 个人资料页，地址栏最后那串 9 位数字',
                  '② 只读取公开的段位数据，不需要密码',
                ]"
                note="它证明「这个账号存在」，不证明「这是你的账号」——所以徽章是「归属未验证」。"
              />
            </div>
            <div style="display: flex; gap: 8px">
              <NInputNumber
                v-model:value="accountForm.id"
                class="mono"
                :min="1"
                :show-button="false"
                placeholder="例如 109902856"
                style="flex: 1; min-width: 0"
                size="medium"
              />
              <NButton :disabled="claiming" :loading="claiming" @click="claimAccount">
                {{ claiming ? '获取中…' : '从 OpenDota 获取' }}
              </NButton>
            </div>
            <p v-if="claimErr" class="alert" style="margin: 10px 0 0">{{ claimErr }}</p>
            <p v-if="claimMsg" class="muted" style="margin: 10px 0 0; font-size: 12px">
              {{ claimMsg }}
            </p>
          </div>
          <div style="padding: 16px 0 12px; border-bottom: 1px dashed var(--line)">
            <div class="field-label" style="margin-bottom: 8px">
              手动填写段位
              <HelpTip
                title="填了天梯分还要选段位吗？"
                :steps="[
                  '① 填了天梯分就不用再选段位——系统按分数折算勋章与星级（每 154 分一星，5420 分以上为冠绝）',
                  '② 手选段位和天梯分对不上时以天梯分为准，保存后自动修正',
                ]"
                note="天梯分本身只作展示参考；当前段位来自 Steam / OpenDota 同步时，这里会锁住不让手填。"
              />
            </div>
            <div class="rank-form">
              <NSelect
                v-model:value="rankForm.medal"
                :options="medalOptions"
                :disabled="derivedRank !== null"
                size="medium"
              />
              <NSelect
                v-if="rankForm.medal !== 8"
                v-model:value="rankForm.star"
                :options="starOptions"
                :disabled="derivedRank !== null"
                size="medium"
              />
              <span v-else class="muted" style="font-size: 12px; text-align: center">
                冠绝无星级
              </span>
              <NInputNumber
                v-model:value="rankForm.mmr"
                class="mono"
                :min="0"
                :max="20000"
                :show-button="false"
                placeholder="天梯分（选填）"
                size="medium"
              />
              <NButton :disabled="rankSaving" :loading="rankSaving" @click="saveRank">
                {{ rankSaving ? '保存中…' : '保存段位' }}
              </NButton>
            </div>
          </div>

          <p v-if="rankErr" class="alert" style="margin: 10px 0 0">{{ rankErr }}</p>
          <p v-if="rankMsg" class="muted" style="margin: 10px 0 0; font-size: 12px">{{ rankMsg }}</p>
        </section>
      </div>

      <!-- 资料 -->
      <section class="card section">
        <h2 class="card-title">
          资料
          <HelpTip
            title="哪些能改？"
            :steps="[
              '① 显示名、QQ、简介随时可以改',
              '② 用户名不可修改——它是登录凭据',
              '③ 评分与段位由系统和管理员维护，不接受自行填写',
            ]"
          />
        </h2>

        <div
          class="grid"
          style="grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px"
        >
          <label class="field" style="margin: 0">
            <span class="field-label">显示名</span>
            <NInput v-model:value="profile.displayName" :maxlength="32" size="medium" />
          </label>
          <label class="field" style="margin: 0">
            <span class="field-label">QQ（选填，仅管理员可见）</span>
            <NInput
              v-model:value="profile.qqNumber"
              :maxlength="12"
              placeholder="例如 123456789"
              size="medium"
            />
          </label>
        </div>

        <label class="field" style="margin: 14px 0 0">
          <span class="field-label">简介</span>
          <NInput
            v-model:value="profile.bio"
            :maxlength="280"
            placeholder="一句话介绍你的打法，会显示在玩家档案上"
            size="medium"
          />
        </label>

        <p v-if="profileError" class="alert" style="margin-top: 14px">{{ profileError }}</p>
        <p v-if="profileSaved" class="muted" style="margin-top: 14px">资料已保存。</p>

        <div style="margin-top: 16px; display: flex; align-items: center; gap: 14px">
          <NButton type="primary" :disabled="profileSaving" :loading="profileSaving" @click="saveProfile">
            {{ profileSaving ? '保存中…' : '保存资料' }}
          </NButton>
        </div>
      </section>

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

      <!-- 账号安全 -->
      <section class="card section">
        <h2 class="card-title">
          账号安全
          <HelpTip
            title="改完密码会怎样？"
            :steps="[
              '① 其他设备会被强制下线，这台保持登录',
              '② 密码只存 PBKDF2 哈希，忘了只能重设，找不回来',
            ]"
            note="改密码不会动评分、报名和已生成的阵容。"
          />
        </h2>

        <div
          class="grid"
          style="grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px"
        >
          <label class="field" style="margin: 0">
            <span class="field-label">当前密码</span>
            <NInput
              v-model:value="pwd.current"
              type="password"
              show-password-on="click"
              placeholder="当前密码"
              :input-props="{ autocomplete: 'current-password' }"
              size="medium"
            />
          </label>
          <label class="field" style="margin: 0">
            <span class="field-label">
              新密码
              <HelpTip title="密码要求" :steps="['至少 10 位', '两次输入要一致']" />
            </span>
            <NInput
              v-model:value="pwd.next"
              type="password"
              show-password-on="click"
              placeholder="至少 10 位"
              :input-props="{ autocomplete: 'new-password' }"
              size="medium"
            />
          </label>
          <label class="field" style="margin: 0">
            <span class="field-label">再输一次新密码</span>
            <NInput
              v-model:value="pwd.confirm"
              type="password"
              show-password-on="click"
              placeholder="再输一次"
              :input-props="{ autocomplete: 'new-password' }"
              size="medium"
            />
          </label>
        </div>

        <p v-if="pwdError" class="alert" style="margin-top: 14px">{{ pwdError }}</p>
        <p v-if="pwdMsg" class="muted" style="margin-top: 14px">{{ pwdMsg }}</p>

        <div style="margin-top: 16px; display: flex; align-items: center; gap: 14px">
          <NButton type="primary" :disabled="pwdSaving" :loading="pwdSaving" @click="changePassword">
            {{ pwdSaving ? '提交中…' : '修改密码' }}
          </NButton>
        </div>
      </section>

      <!-- 位置偏好 -->
      <section class="card section">
        <h2 class="card-title">
          位置偏好
          <HelpTip
            wide
            title="志愿和熟练度怎么用？"
            :steps="[
              '① 志愿顺序决定分队时你被安排的位置；只填一个位置，队伍里就必然有人打不上本命位',
              '② 熟练度是你在这个位置的真实水平：100 = 完全胜任，0 = 勉强能顶',
              '③ 契合度 = 志愿基准（第一志愿 100，之后每降一档 −20）+ 熟练度修正（±25）',
            ]"
            note="熟练度只影响分队时的位置契合度，不影响 WARROOM 评分。建议填 3–5 个位置；保存后下次生成阵容才生效，已公布的阵容不会变。"
          />
        </h2>

        <div class="pos-head">
          <span>位置</span>
          <span>志愿顺序</span>
          <span>熟练度 0–100</span>
        </div>

        <div class="pos-list">
          <div v-for="slot in slots" :key="slot.position" class="pos-row">
            <div class="pos-name">{{ POSITION_NAMES[slot.position] }}</div>

            <NSelect
              v-model:value="slot.rank"
              :options="rankSelectOptions(slot)"
              class="pos-select"
              size="medium"
            />

            <div class="pos-prof">
              <input
                v-model.number="slot.proficiency"
                type="range"
                min="0"
                max="100"
                step="5"
                :disabled="slot.rank === 0"
              />
              <span class="mono muted" style="width: 34px; text-align: right">
                {{ slot.rank === 0 ? '—' : slot.proficiency }}
              </span>
            </div>
          </div>
        </div>

        <p v-if="!contiguous" class="alert" style="margin-top: 16px">
          志愿顺序必须从第 1 志愿开始连续填写，不能跳档。
        </p>

        <p v-if="error" class="alert" style="margin-top: 16px">{{ error }}</p>
        <p v-if="saved" class="muted" style="margin-top: 16px">
          已保存。下次生成阵容时生效——已发布的阵容不会因为改偏好而变化。
        </p>

        <div style="margin-top: 18px; display: flex; gap: 10px; align-items: center">
          <NButton type="primary" :disabled="!canSave" :loading="saving" @click="save">
            {{ saving ? '保存中…' : '保存位置偏好' }}
          </NButton>
          <span class="muted" style="font-size: 12px">
            已选 {{ chosen.length }} 个位置
          </span>
        </div>
      </section>
    </template>
  </div>
</template>
