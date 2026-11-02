<script setup lang="ts">
/**
 * 游戏身份卡（我的主页）—— Steam / 数字 ID / 手动 三选一。
 *
 * 为什么是 tab 而不是三段堆叠：
 *   三条路径互斥（一人一个账号），堆在一起既占高度又让人以为"可以都填"。
 *   左边 WARROOM Rating 卡是"先给结论再给依据"的节奏，这张卡照抄同样的节奏：
 *   顶部一行结论（谁、段位多少、从哪来）→ 下面才是操作。
 *
 * 优先级规则（服务端同样强制，见 PUT /api/me/rank）：
 *   Steam / OpenDota / 管理员设定 拿到的段位 > 手填。
 *   只要上游给了段位数据，手动填写就锁死，必须先解除绑定；
 *   上游没给数据（比如对方没开公开比赛数据）时，手动填写仍然可用——
 *   否则用户就彻底没法填段位了。
 */
import { computed, ref, watch } from 'vue';
import { NButton, NInputNumber, NPopconfirm, NSelect, NTabPane, NTabs, useMessage } from 'naive-ui';
import HelpTip from '../HelpTip.vue';
import { ApiError, api } from '../../lib/api';
import { loadMe, session } from '../../lib/session';

const message = useMessage();

const account = computed(() => session.me?.gameAccount ?? null);
const isVerified = computed(() => account.value?.verification === 'VERIFIED');
const isClaimed = computed(() => account.value?.verification === 'CLAIMED');

const MEDALS = ['先锋', '卫士', '中军', '统帅', '传奇', '万古流芳', '超凡入圣', '冠绝'];
const MEDAL_FLOORS = [0, 770, 1540, 2310, 3080, 3850, 4620, 5420];
const medalOptions = MEDALS.map((name, index) => ({ label: name, value: index + 1 }));
const starOptions = [1, 2, 3, 4, 5].map((s) => ({ label: `${s} 星`, value: s }));

/* ---------------------------------------------------------------- 结论行 */
const rankLabel = computed(() => {
  const tier = session.me?.stats?.rankTier;
  if (!tier) return '未采集';
  const medal = Math.floor(tier / 10);
  const star = tier % 10;
  return medal === 8 ? (MEDALS[medal - 1] ?? '未知') : `${MEDALS[medal - 1] ?? '未知'} ${star} 星`;
});

const rankSourceLabel = computed(() => {
  const source = session.me?.stats?.rankSource;
  if (source === 'OPENDOTA') return 'OpenDota 同步';
  if (source === 'STRATZ') return 'STRATZ 同步';
  if (source === 'SELF_REPORTED') return '手动填写';
  if (source === 'ADMIN_SET') return '管理员设定';
  return null;
});

/**
 * 上游段位（决定手动填写能不能用）。
 * 注意要同时要求 rank_tier 有值：同步成功但对方没开公开数据时，
 * rank_source 会写成 OPENDOTA 而段位是空的，那种情况必须继续允许手填。
 */
const upstreamRank = computed(() => {
  const stats = session.me?.stats;
  if (!stats?.rankTier) return null;
  if (stats.rankSource === 'OPENDOTA' || stats.rankSource === 'STRATZ') return 'synced';
  if (stats.rankSource === 'ADMIN_SET') return 'admin';
  return null;
});

/** 手填被锁：上游已经给了段位 */
const manualLocked = computed(() => upstreamRank.value !== null);
const lockReason = computed(() => {
  if (upstreamRank.value === 'admin') return '当前段位由管理员设定';
  return `当前段位来自 ${rankSourceLabel.value ?? '上游同步'}`;
});

const badgeText = computed(() => {
  if (isVerified.value) return '✓ Steam 已验证';
  if (isClaimed.value) return '数据已校验 · 归属未验证';
  return '未绑定 · 段位自报';
});
const badgeClass = computed(() =>
  isVerified.value ? 'pill-open' : isClaimed.value ? 'pill-closed' : 'pill-idle',
);

/* ---------------------------------------------------------------- tab 选择 */
type TabName = 'steam' | 'number' | 'manual';
const tab = ref<TabName>('manual');

/** 默认落在"当前生效的那条路"上，避免一进页面就看到一堆无关表单 */
watch(
  () => session.me?.gameAccount,
  (acc) => {
    if (acc?.verification === 'VERIFIED') tab.value = 'steam';
    else if (acc?.verification === 'CLAIMED') tab.value = 'number';
    else tab.value = 'manual';
  },
  { immediate: true },
);

/* ---------------------------------------------------------------- 手动段位 */
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
};

/** 填了天梯分就锁定段位选择，并由分数反推显示 */
const derivedRank = computed(() =>
  rankForm.value.mmr !== null && rankForm.value.mmr > 0 ? rankFromMmr(rankForm.value.mmr) : null,
);

watch(derivedRank, (derived) => {
  if (!derived) return;
  rankForm.value.medal = derived.medal;
  rankForm.value.star = derived.star;
});

// 表单初值跟随已同步的数据，避免"库里是万古流芳、表单显示统帅"
watch(
  () => session.me?.stats,
  (stats) => {
    if (!stats?.rankTier) return;
    rankForm.value.medal = Math.floor(stats.rankTier / 10);
    rankForm.value.star = stats.rankTier % 10 || 1;
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
    const rankTier =
      rankForm.value.medal === 8 ? 80 : rankForm.value.medal * 10 + rankForm.value.star;

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

/* ---------------------------------------------------------------- 数字 ID */
const accountForm = ref({ id: null as number | null });
const claiming = ref(false);
const claimMsg = ref('');
const claimErr = ref('');
/** 已声明过账号时，默认收起输入框；点「更换」才展开 */
const changingAccount = ref(false);

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
    changingAccount.value = false;
    claimMsg.value = result.hiddenData
      ? `${result.personaName ?? '该账号'} 没有公开段位，请在 Dota2 里开启「公开比赛数据」，或切到「手动」自己填`
      : `已同步 ${result.personaName ?? ''} 的段位，评分更新为 ${result.rating.effective}`;
    message.success('已从 OpenDota 同步');
  } catch (err) {
    claimErr.value = err instanceof ApiError ? err.message : '获取失败';
  } finally {
    claiming.value = false;
  }
}

/* ---------------------------------------------------------------- 绑定 / 解绑 */
const steamBusy = ref(false);

/** 解绑会删掉 game_accounts 整行；段位会保留数字但退回「自报」，之后手填解锁 */
async function unbind() {
  steamBusy.value = true;
  try {
    await api('/auth/steam/unlink', { method: 'DELETE' });
    await loadMe();
    changingAccount.value = false;
    message.success('已解除绑定，段位已转为「自报」，现在可以手动填写');
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
</script>

<template>
  <section class="card">
    <h2 class="card-title">
      游戏身份
      <HelpTip
        wide
        title="身份怎么验证？"
        :steps="[
          '① Steam 登录只是跳到 Steam 官方页面确认身份，本站接触不到你的密码',
          '② 数字 ID 只证明这个账号存在且有公开数据，不能证明它是你的',
          '③ 三条路只能走一条：Steam / 数字 ID / 手动，后绑定会替换前一个',
        ]"
        note="归属验证只有 Steam 能给。段位以 Steam、数字 ID 同步来的为准；上游给了段位之后手动填写会锁住，要自己填就得先解除绑定（段位数字会保留，来源改成「自报」）。"
      />
    </h2>

    <!-- 结论行：和左边评分卡一样，先给结论 -->
    <div class="identity-state">
      <span class="pill" :class="badgeClass">{{ badgeText }}</span>
      <div class="identity-rank">
        <span class="mono identity-rank-value" :class="rankLabel === '未采集' ? 'identity-rank-empty' : ''">
          {{ rankLabel }}
        </span>
        <span class="muted identity-rank-src">{{ rankSourceLabel ?? '段位待采集' }}</span>
      </div>
    </div>

    <NTabs v-model:value="tab" type="segment" size="medium" class="identity-tabs" animated>
      <!-- ---------------------------------------------------------- Steam -->
      <NTabPane name="steam" tab="Steam">
        <template v-if="isVerified">
          <div class="id-row">
            <span class="stat-label">DOTA ID</span>
            <span class="mono">{{ account?.dotaAccountId }}</span>
          </div>
          <div class="id-row">
            <span class="stat-label">游戏昵称</span>
            <span class="mono">{{ account?.personaName ?? '—' }}</span>
          </div>
          <div class="identity-actions">
            <NButton :disabled="steamBusy" :loading="steamBusy" @click="rebindSteam">
              重新认证
            </NButton>
            <NPopconfirm @positive-click="unbind">
              <template #trigger>
                <NButton :disabled="steamBusy">解绑</NButton>
              </template>
              解绑会删除 Steam 归属验证，段位保留但来源改成「自报」，之后可以重新绑定。确定解绑吗？
            </NPopconfirm>
          </div>
        </template>

        <template v-else>
          <p class="muted identity-hint">
            跳到 Steam 官方页面确认身份，本站接触不到你的密码；绑定后自动同步 DOTA ID 与段位。
          </p>
          <div class="identity-actions">
            <a class="btn" href="/api/auth/steam/start">绑定 Steam</a>
          </div>
        </template>
      </NTabPane>

      <!-- ------------------------------------------------------- 数字 ID -->
      <NTabPane name="number" tab="数字 ID">
        <p v-if="isVerified" class="muted identity-hint">
          已通过 Steam 验证，这个入口是给不绑 Steam 的人用的降级方案，无需再填。
        </p>

        <template v-else-if="isClaimed && !changingAccount">
          <div class="id-row">
            <span class="stat-label">DOTA ID</span>
            <span class="mono">{{ account?.dotaAccountId }}</span>
          </div>
          <div class="id-row">
            <span class="stat-label">游戏昵称</span>
            <span class="mono">{{ account?.personaName ?? '—' }}</span>
          </div>
          <div class="identity-actions">
            <NButton @click="changingAccount = true">更换数字 ID</NButton>
            <NPopconfirm @positive-click="unbind">
              <template #trigger>
                <NButton :disabled="steamBusy">解除绑定</NButton>
              </template>
              解除后可以改成手动填写段位。确定吗？
            </NPopconfirm>
          </div>
        </template>

        <template v-else>
          <p class="muted identity-hint">
            填 Dota2 个人资料地址栏里那串 9 位数字，只读取公开数据，不需要密码。
          </p>
          <div class="identity-claim">
            <NInputNumber
              v-model:value="accountForm.id"
              class="mono"
              :min="1"
              :show-button="false"
              placeholder="例如 109902856"
              size="medium"
            />
            <NButton :disabled="claiming" :loading="claiming" @click="claimAccount">
              {{ claiming ? '获取中…' : '从 OpenDota 获取' }}
            </NButton>
          </div>
          <p v-if="claimErr" class="alert identity-note">{{ claimErr }}</p>
          <p v-if="claimMsg" class="muted identity-note">{{ claimMsg }}</p>
        </template>
      </NTabPane>

      <!-- --------------------------------------------------------- 手动 -->
      <NTabPane name="manual" tab="手动">
        <template v-if="manualLocked">
          <p class="identity-lock">
            {{ lockReason }}，手动填写已锁定。
            <template v-if="upstreamRank === 'admin'">如需改动请联系管理员。</template>
            <template v-else>要自己填，先解除绑定。</template>
          </p>
          <div v-if="upstreamRank !== 'admin'" class="identity-actions">
            <NPopconfirm @positive-click="unbind">
              <template #trigger>
                <NButton :disabled="steamBusy">解除绑定后手填</NButton>
              </template>
              解绑会删除账号绑定，段位数字保留但来源改成「自报」。确定吗？
            </NPopconfirm>
          </div>
        </template>

        <template v-else>
          <div class="rank-form">
            <NSelect v-model:value="rankForm.medal" :options="medalOptions" :disabled="derivedRank !== null" size="medium" />
            <NSelect
              v-if="rankForm.medal !== 8"
              v-model:value="rankForm.star"
              :options="starOptions"
              :disabled="derivedRank !== null"
              size="medium"
            />
            <span v-else class="muted identity-hint">冠绝无星级</span>
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
          <p class="muted identity-note">
            填了天梯分就不用再选段位，系统按分数折算勋章与星级；段位为自报，绑定 Steam 后可以验证。
          </p>
          <p v-if="rankErr" class="alert identity-note">{{ rankErr }}</p>
          <p v-if="rankMsg" class="muted identity-note">{{ rankMsg }}</p>
        </template>
      </NTabPane>
    </NTabs>
  </section>
</template>
