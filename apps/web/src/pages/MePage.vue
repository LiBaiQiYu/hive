<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import { ApiError, api } from '../lib/api';
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
  } catch (err) {
    profileError.value = err instanceof ApiError ? err.message : '保存失败';
  } finally {
    profileSaving.value = false;
  }
}

/* ---------------------------------------------------------------- 手动段位 */
const MEDALS = ['先锋', '卫士', '中军', '统帅', '传奇', '万古流芳', '超凡入圣', '冠绝'];
const MEDAL_FLOORS = [0, 770, 1540, 2310, 3080, 3850, 4620, 5420];
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
  } catch (err) {
    claimErr.value = err instanceof ApiError ? err.message : '获取失败';
  } finally {
    claiming.value = false;
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
          <h2 class="card-title">WARROOM Rating</h2>

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

            <details class="explainer">
              <summary>这个分怎么算的？</summary>
              <div class="explainer-body">
                <p>
                  这是 HIVE 用来分队的内部评分，范围 0–1000。它和你的天梯 MMR 不是一回事，
                  也不能直接比较——它只回答一个问题：
                  <strong>在这十几个人里，怎么分队两边才更接近。</strong>
                </p>
                <ul>
                  <li><b>段位 900</b> · 天梯勋章与 MMR，几乎决定全部实力判断</li>
                  <li><b>社区出勤 100</b> · 报名后是否到场；报了不来按缺席比例扣分</li>
                </ul>
                <p>
                  只算这两项，是因为它们几乎没有争议：段位是 Valve 给你的标签，
                  出勤是能数出来的事实。近期战绩和英雄池不参与算分——
                  15 人的社区里 20 局胜负的样本太小，用它们评判实力只会把所有人拉向平均。
                  位置能力也不在评分里，它属于分队逻辑（决定你站哪个位置，不影响你有多强）。
                </p>
                <p>
                  样本不足时会向 500（基准线）收缩，所以新人的分数不会因为两三局连胜就虚高。
                  管理员可以修正，但必须填写原因且不可删除；修正幅度会随数据可信度放宽（最多 ±500）。
                </p>
                <p class="muted">
                  报名与分组时会冻结当时的评分快照，之后调整评分不会影响已公布的阵容。
                  算法版本 {{ rating.algorithmVersion }}。
                </p>
              </div>
            </details>
          </template>

          <p v-else class="muted" style="margin: 0">
            还没有评分记录。绑定 Steam 或填写段位后，管理员可以为你设定初始评分。
          </p>
        </section>

        <!-- 身份 -->
        <section class="card">
          <h2 class="card-title">游戏身份</h2>

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
          <p v-else class="muted" style="margin: 0 0 12px">
            尚未绑定游戏账号。绑定后可以自动获取段位与近期表现；不绑定也可以由管理员手动设定评分。
          </p>

          <div class="id-row">
            <span class="stat-label">归属验证</span>
            <a
              v-if="account?.verification !== 'VERIFIED'"
              class="btn"
              href="/api/auth/steam/start"
              title="跳转到 Steam 官方页面确认身份，本站接触不到你的密码"
            >
              绑定 Steam
            </a>
            <span v-else class="muted" style="font-size: 13px">Steam 已验证</span>
          </div>

          <p
            v-if="account && account.verification !== 'VERIFIED'"
            class="muted"
            style="font-size: 12px; margin: 0 0 10px"
          >
            当前段位来自数字 ID，只能证明"这个账号存在"，不能证明"这是你的账号"。
            绑定 Steam 可以把它升级为「已认证」。
          </p>

          <div
            v-if="account?.verification !== 'VERIFIED'"
            style="padding: 12px 0; border-bottom: 1px dashed var(--line)"
          >
            <div class="field-label" style="margin-bottom: 8px">
              用数字 ID 获取段位（免 Steam）
            </div>
            <div style="display: flex; gap: 8px">
              <input
                v-model.number="accountForm.id"
                class="input mono"
                type="number"
                placeholder="例如 109902856"
                style="flex: 1; min-width: 0"
              />
              <button class="btn" type="button" :disabled="claiming" @click="claimAccount">
                {{ claiming ? '获取中…' : '从 OpenDota 获取' }}
              </button>
            </div>
            <p v-if="claimErr" class="alert" style="margin: 10px 0 0">{{ claimErr }}</p>
            <p v-if="claimMsg" class="muted" style="margin: 10px 0 0; font-size: 12px">
              {{ claimMsg }}
            </p>
            <p class="muted" style="font-size: 11px; margin: 8px 0 0">
              数字 ID 是 Dota2 个人资料页那串 9 位数字。它只证明"这个账号存在且有公开数据"，
              不能证明"这是你的账号"——所以徽章会显示「归属未验证」。
            </p>
          </div>
          <div style="padding: 16px 0 12px; border-bottom: 1px dashed var(--line)">
            <div class="field-label" style="margin-bottom: 8px">手动填写段位</div>
            <div class="rank-form">
              <select v-model.number="rankForm.medal" class="input" :disabled="derivedRank !== null">
                <option v-for="(name, index) in MEDALS" :key="name" :value="index + 1">
                  {{ name }}
                </option>
              </select>
              <select
                v-if="rankForm.medal !== 8"
                v-model.number="rankForm.star"
                class="input"
                :disabled="derivedRank !== null"
              >
                <option v-for="s in 5" :key="s" :value="s">{{ s }} 星</option>
              </select>
              <span v-else class="muted" style="font-size: 12px; text-align: center">
                冠绝无星级
              </span>
              <input
                v-model.number="rankForm.mmr"
                class="input mono"
                type="number"
                min="0"
                max="20000"
                placeholder="天梯分（选填）"
              />
              <button class="btn" type="button" :disabled="rankSaving" @click="saveRank">
                {{ rankSaving ? '保存中…' : '保存段位' }}
              </button>
            </div>
          </div>

          <p v-if="rankErr" class="alert" style="margin: 10px 0 0">{{ rankErr }}</p>
          <p v-if="rankMsg" class="muted" style="margin: 10px 0 0; font-size: 12px">{{ rankMsg }}</p>
          <p class="muted" style="font-size: 12px; margin: 8px 0 0">
            填了天梯分就<b>不用再选段位</b>——系统会按分数自动折算勋章与星级（每 154 分一星，
            5420 分以上为冠绝）。如果手选的段位和天梯分对不上，<b>以天梯分为准</b>，
            保存后自动修正为对应段位。天梯分本身只作展示参考。
          </p>

          <p class="muted" style="font-size: 12px; margin: 16px 0 0">
            说明：Steam 登录只是跳转到 Steam 官方页面确认身份，本站接触不到你的密码。
            如果你不想绑定，手动填写段位同样可用——只是会显示"未验证"标记。
          </p>
        </section>
      </div>

      <!-- 资料 -->
      <section class="card section">
        <h2 class="card-title">资料</h2>

        <div
          class="grid"
          style="grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px"
        >
          <label class="field" style="margin: 0">
            <span class="field-label">显示名</span>
            <input v-model="profile.displayName" class="input" maxlength="32" />
          </label>
          <label class="field" style="margin: 0">
            <span class="field-label">QQ（选填，仅管理员可见）</span>
            <input v-model="profile.qqNumber" class="input" maxlength="12" placeholder="例如 123456789" />
          </label>
        </div>

        <label class="field" style="margin: 14px 0 0">
          <span class="field-label">简介</span>
          <input
            v-model="profile.bio"
            class="input"
            maxlength="280"
            placeholder="一句话介绍你的打法，会显示在玩家档案上"
          />
        </label>

        <p v-if="profileError" class="alert" style="margin-top: 14px">{{ profileError }}</p>
        <p v-if="profileSaved" class="muted" style="margin-top: 14px">资料已保存。</p>

        <div style="margin-top: 16px; display: flex; align-items: center; gap: 14px">
          <button class="btn btn-primary" type="button" :disabled="profileSaving" @click="saveProfile">
            {{ profileSaving ? '保存中…' : '保存资料' }}
          </button>
          <span class="muted" style="font-size: 12px">
            用户名不可修改（它是登录凭据）；评分与段位由系统和管理员维护，不接受自行填写。
          </span>
        </div>
      </section>

      <!-- 位置偏好 -->
      <section class="card section">
        <h2 class="card-title">位置偏好</h2>
        <p class="muted" style="margin: 0 0 18px; font-size: 13px">
          志愿顺序决定分队时你被安排的位置。填写得越完整，分组结果越贴近你的实际水平——
          只填一个位置的话，队伍里必然有人打不上本命位。
        </p>

        <div
          style="
            display: grid;
            grid-template-columns: minmax(150px, 1.2fr) 140px minmax(160px, 1fr);
            gap: 16px;
            padding: 0 12px 8px;
            font-size: 11px;
            letter-spacing: 0.16em;
            text-transform: uppercase;
            color: var(--muted);
          "
        >
          <span>位置</span>
          <span>志愿顺序</span>
          <span>熟练度 0–100</span>
        </div>

        <div class="pos-list">
          <div v-for="slot in slots" :key="slot.position" class="pos-row">
            <div class="pos-name">{{ POSITION_NAMES[slot.position] }}</div>

            <select v-model.number="slot.rank" class="input pos-select">
              <option v-for="rank in rankOptions(slot)" :key="rank" :value="rank">
                {{ rank === 0 ? '不打' : `第 ${rank} 志愿` }}
              </option>
            </select>

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

        <div
          class="muted"
          style="
            margin-top: 16px;
            padding: 12px 14px;
            border-left: 2px solid var(--line-strong);
            background: rgba(255, 255, 255, 0.02);
            border-radius: 0 6px 6px 0;
            font-size: 12px;
            line-height: 1.9;
          "
        >
          <div style="color: var(--text); margin-bottom: 4px">滑条上的数字是什么意思？</div>
          <p style="margin: 0 0 6px">
            <strong>熟练度</strong>是你在这个位置的真实水平：<b>100</b> 表示完全胜任、可以放心交给你，
            <b>0</b> 表示勉强能顶、尽量别安排。它只影响分队时的位置契合度，不影响你的 WARROOM 评分。
          </p>
          <p style="margin: 0 0 6px">
            契合度 = 志愿基准（第一志愿 100，之后每降一档 −20）+ 熟练度修正（<code>±25</code>）。
            所以「第二志愿但熟练度 100」的人（契合 100）会排在「第一志愿但熟练度 0」的人（契合 75）前面——
            志愿是偏好，熟练度才是你实际能不能打。
          </p>
          <p style="margin: 0">
            填 <b>3–5 个位置</b>最好：只填一个位置时，一旦同位置的人报多了，队伍里必然有人要打不熟的位置。
          </p>
        </div>
        <p v-if="error" class="alert" style="margin-top: 16px">{{ error }}</p>
        <p v-if="saved" class="muted" style="margin-top: 16px">
          已保存。下次生成阵容时生效——已发布的阵容不会因为改偏好而变化。
        </p>

        <div style="margin-top: 18px; display: flex; gap: 10px; align-items: center">
          <button class="btn btn-primary" type="button" :disabled="!canSave" @click="save">
            {{ saving ? '保存中…' : '保存位置偏好' }}
          </button>
          <span class="muted" style="font-size: 12px">
            已选 {{ chosen.length }} 个位置
          </span>
        </div>
      </section>
    </template>
  </div>
</template>
