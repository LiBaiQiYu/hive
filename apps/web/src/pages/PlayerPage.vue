<script setup lang="ts">
/**
 * 玩家主页：别人眼里的你。
 *
 * 结构刻意和「我的主页」对齐（卡片在上、数据在下），但从任何入口进来看到的都是
 * **同一份公开数据**——没有 QQ、邮箱、SteamID64，只有卡片、战绩和社交互动。
 *
 * 留言是两级：一级评论 + 回复。回复"回复"时服务端会挂到同一个根上，
 * 前端不做无限嵌套（窄屏排不下）。
 */
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { NButton, NInput, NPopconfirm, useMessage } from 'naive-ui';
import PageBack from '../components/PageBack.vue';
import PlayerCard, { type PlayerCardData } from '../components/PlayerCard.vue';
import { ApiError, api, formatDate } from '../lib/api';
import { session } from '../lib/session';

interface PlayerProfile {
  userId: string;
  username: string;
  displayName: string;
  bio: string | null;
  joinedAt: number;
  position: number | null;
  rankTier: number | null;
  declaredMmr: number | null;
  rankSource: string | null;
  rating: number | null;
  verification: string;
  personaName: string | null;
  dotaAccountId: number | null;
  skin: PlayerCardData['skin'];
}

interface MatchRow {
  matchId: string;
  matchNo: number;
  eventId: string;
  eventTitle: string;
  side: 'RADIANT' | 'DIRE';
  won: boolean;
  durationSeconds: number | null;
  playedAt: number | null;
}

interface CommentItem {
  id: string;
  parentId: string | null;
  body: string;
  deleted: boolean;
  createdAt: number;
  author: { id: string; displayName: string; username: string };
  likeCount: number;
  likedByMe: boolean;
}

interface Thread extends CommentItem {
  replies: CommentItem[];
}

const route = useRoute();
const message = useMessage();
const playerId = computed(() => String(route.params.id ?? ''));

const loading = ref(true);
const error = ref('');
const player = ref<PlayerProfile | null>(null);
const summary = ref({ played: 0, wins: 0, losses: 0, winRateBp: null as number | null });
const matches = ref<MatchRow[]>([]);
const reactions = ref({ likes: 0, dislikes: 0, mine: null as 'LIKE' | 'DISLIKE' | null });
const isSelf = ref(false);
const threads = ref<Thread[]>([]);
const commentsLoading = ref(false);

const isLoggedIn = computed(() => session.me !== null);
const isAdmin = computed(() => session.me?.user.role === 'ADMIN');

/* ---------------------------------------------------------------- 档案 */
async function loadProfile() {
  loading.value = true;
  error.value = '';
  try {
    const data = await api<{
      player: PlayerProfile;
      summary: typeof summary.value;
      matches: MatchRow[];
      reactions: typeof reactions.value;
      isSelf: boolean;
    }>(`/players/${playerId.value}`);
    player.value = data.player;
    summary.value = data.summary;
    matches.value = data.matches;
    reactions.value = data.reactions;
    isSelf.value = data.isSelf;
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '加载失败';
  } finally {
    loading.value = false;
  }
}

const cardPlayer = computed<PlayerCardData>(() => {
  const p = player.value;
  return {
    userId: p?.userId ?? '',
    status: 'CONFIRMED',
    displayName: p?.displayName ?? '',
    bio: p?.bio ?? null,
    position: p?.position ?? null,
    rankTier: p?.rankTier ?? null,
    declaredMmr: p?.declaredMmr ?? null,
    rating: p?.rating ?? null,
    verification: p?.verification ?? 'SELF_REPORTED',
    personaName: p?.personaName ?? null,
    dotaAccountId: p?.dotaAccountId ?? null,
    skin: p?.skin ?? null,
  };
});

const winRate = computed(() =>
  summary.value.winRateBp === null ? '—' : `${(summary.value.winRateBp / 100).toFixed(0)}%`,
);

/**
 * 返回目标：**优先回上一页**（`<PageBack back>` 会读 history.state）。
 * 这里的 `backLink` 只是兜底——站外直接打开 /players/:id（分享链接、新标签页）时，
 * 历史里没有站内来源，才需要给个固定去处：
 * 看自己的公开主页时回「我的主页」比回排行榜顺手，用 session 判断而不是接口的 isSelf，
 * 后者要等加载完，会让按钮闪一下。
 */
const backLink = computed(() =>
  session.me?.user.id === playerId.value
    ? { to: '/me', label: '返回我的主页' }
    : { to: '/leaderboard', label: '返回排行榜' },
);

function duration(seconds: number | null): string {
  if (!seconds) return '—';
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

/* ---------------------------------------------------------------- 点赞点踩 */
const reactionBusy = ref(false);

async function vote(kind: 'LIKE' | 'DISLIKE') {
  if (!isLoggedIn.value) {
    message.warning('登录后才能投票');
    return;
  }
  if (isSelf.value) return;
  reactionBusy.value = true;
  try {
    // 再点同一个 = 取消（服务端按"相同则删、不同则改票"处理）
    const data = await api<typeof reactions.value>(`/players/${playerId.value}/reaction`, {
      method: 'POST',
      body: { kind },
    });
    reactions.value = data;
  } catch (err) {
    message.error(err instanceof ApiError ? err.message : '操作失败');
  } finally {
    reactionBusy.value = false;
  }
}

/* ---------------------------------------------------------------- 留言板 */
const draft = ref('');
const posting = ref(false);
const replyTo = ref<string | null>(null);
const replyDraft = ref('');

async function loadComments() {
  commentsLoading.value = true;
  try {
    const data = await api<{ threads: Thread[] }>(`/players/${playerId.value}/comments`);
    threads.value = data.threads;
  } catch {
    threads.value = [];
  } finally {
    commentsLoading.value = false;
  }
}

async function post(parentId: string | null) {
  if (!isLoggedIn.value) {
    message.warning('登录后才能留言');
    return;
  }
  const body = (parentId ? replyDraft : draft).value.trim();
  if (!body) return;

  posting.value = true;
  try {
    await api(`/players/${playerId.value}/comments`, {
      method: 'POST',
      body: { body, parentId },
    });
    if (parentId) {
      replyDraft.value = '';
      replyTo.value = null;
    } else {
      draft.value = '';
    }
    await loadComments();
    message.success('已发布');
  } catch (err) {
    message.error(err instanceof ApiError ? err.message : '发布失败');
  } finally {
    posting.value = false;
  }
}

async function removeComment(commentId: string) {
  try {
    await api(`/players/${playerId.value}/comments/${commentId}`, { method: 'DELETE' });
    await loadComments();
    message.success('已删除');
  } catch (err) {
    message.error(err instanceof ApiError ? err.message : '删除失败');
  }
}

async function likeComment(comment: CommentItem) {
  if (!isLoggedIn.value) {
    message.warning('登录后才能点赞');
    return;
  }
  try {
    const data = await api<{ commentId: string; likeCount: number; likedByMe: boolean }>(
      `/players/${playerId.value}/comments/${comment.id}/like`,
      { method: 'POST' },
    );
    comment.likeCount = data.likeCount;
    comment.likedByMe = data.likedByMe;
  } catch (err) {
    message.error(err instanceof ApiError ? err.message : '操作失败');
  }
}

const canDelete = (comment: CommentItem) =>
  !comment.deleted && (isAdmin.value || comment.author.id === session.me?.user.id);

/* ---------------------------------------------------------------- 生命周期 */
onMounted(async () => {
  await loadProfile();
  await loadComments();
});

watch(playerId, async () => {
  await loadProfile();
  await loadComments();
});
</script>

<template>
  <div class="container">
    <!-- 从任何卡片/评论进来都回上一页；只有站外直接打开时才回落到 backLink -->
    <PageBack back :to="backLink.to" :label="backLink.label" />

    <div v-if="loading" class="empty" style="display: flex; justify-content: center; padding: 40px">
      加载中…
    </div>

    <div v-else-if="error" class="empty">{{ error }}</div>

    <template v-else-if="player">
      <div class="player-hero">
        <div class="player-card-wrap">
          <PlayerCard :player="cardPlayer" />
        </div>

        <div class="player-side">
          <div class="section-head" style="margin-bottom: 10px">
            <h1 class="section-title" style="font-size: 22px">{{ player.displayName }}</h1>
            <span class="muted" style="font-size: 12px">@{{ player.username }}</span>
          </div>

          <div class="player-stats">
            <div class="player-stat">
              <span class="stat-label">WARROOM</span>
              <span class="mono player-stat-value">{{ player.rating ?? 500 }}</span>
            </div>
            <div class="player-stat">
              <span class="stat-label">场次</span>
              <span class="mono player-stat-value">{{ summary.played }}</span>
            </div>
            <div class="player-stat">
              <span class="stat-label">胜负</span>
              <span class="mono player-stat-value">
                {{ summary.wins }}<span class="muted"> / </span>{{ summary.losses }}
              </span>
            </div>
            <div class="player-stat">
              <span class="stat-label">胜率</span>
              <span class="mono player-stat-value">{{ winRate }}</span>
            </div>
          </div>

          <div class="player-votes">
            <NButton
              :disabled="reactionBusy || isSelf"
              :class="{ 'is-active': reactions.mine === 'LIKE' }"
              @click="vote('LIKE')"
            >
              👍 {{ reactions.likes }}
            </NButton>
            <NButton
              :disabled="reactionBusy || isSelf"
              :class="{ 'is-active': reactions.mine === 'DISLIKE' }"
              @click="vote('DISLIKE')"
            >
              👎 {{ reactions.dislikes }}
            </NButton>
            <span v-if="isSelf" class="muted" style="font-size: 12px">不能给自己投票</span>
          </div>

          <p class="muted player-joined">
            加入于 {{ formatDate(player.joinedAt) }}
            <template v-if="player.dotaAccountId">
              · DOTA ID
              <a
                class="mono"
                :href="`https://stratz.com/players/${player.dotaAccountId}`"
                target="_blank"
                rel="noopener noreferrer"
                title="在 STRATZ 查看这个账号的公开资料"
              >{{ player.dotaAccountId }}</a>
            </template>
          </p>
        </div>
      </div>

      <!-- ---------------------------------------------------------- 战绩 -->
      <section class="section">
        <div class="section-head">
          <h2 class="section-title">对局记录</h2>
          <RouterLink to="/records" class="muted" style="font-size: 12px">全员胜场 →</RouterLink>
        </div>

        <div v-if="matches.length === 0" class="empty">还没有打完的比赛。</div>

        <div v-else class="card" style="padding: 8px 12px">
          <table class="table">
            <thead>
              <tr>
                <th>时间</th>
                <th>赛事</th>
                <th class="num">场次</th>
                <th>我方</th>
                <th>结果</th>
                <th class="num">时长</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="match in matches" :key="match.matchId">
                <td class="muted">{{ formatDate(match.playedAt) }}</td>
                <td>
                  <RouterLink
                    :to="`/events/${match.eventId}`"
                    style="color: var(--text); text-decoration: none"
                  >
                    {{ match.eventTitle }}
                  </RouterLink>
                </td>
                <td class="num mono">
                  <RouterLink :to="`/matches/${match.matchId}`" style="color: var(--gold-2)">
                    第 {{ match.matchNo }} 场
                  </RouterLink>
                </td>
                <td>
                  <span class="muted">{{ match.side === 'RADIANT' ? '天辉' : '夜魇' }}</span>
                </td>
                <td>
                  <span :class="match.won ? 'tag tag-confirmed' : 'tag tag-other'">
                    {{ match.won ? '胜' : '负' }}
                  </span>
                </td>
                <td class="num mono muted">{{ duration(match.durationSeconds) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- -------------------------------------------------------- 留言板 -->
      <section class="section">
        <div class="section-head">
          <h2 class="section-title">留言板</h2>
          <span class="muted" style="font-size: 12px">{{ threads.length }} 条</span>
        </div>

        <div class="card comment-composer">
          <NInput
            v-model:value="draft"
            type="textarea"
            placeholder="说点什么…（最多 1000 字）"
            :maxlength="1000"
            :autosize="{ minRows: 3, maxRows: 6 }"
          />
          <div class="comment-composer-foot">
            <span class="muted" style="font-size: 12px">
              {{ isLoggedIn ? '留言对所有人可见' : '登录后才能留言' }}
            </span>
            <NButton
              type="primary"
              :disabled="posting || !isLoggedIn || draft.trim().length === 0"
              :loading="posting"
              @click="post(null)"
            >
              发表留言
            </NButton>
          </div>
        </div>

        <div v-if="commentsLoading" class="empty" style="margin-top: 14px">加载留言…</div>
        <div v-else-if="threads.length === 0" class="empty" style="margin-top: 14px">
          还没有人留言，做第一个。
        </div>

        <div v-else class="comment-list">
          <article v-for="thread in threads" :key="thread.id" class="comment">
            <header class="comment-head">
              <RouterLink :to="`/players/${thread.author.id}`" class="comment-author">
                {{ thread.author.displayName }}
              </RouterLink>
              <span class="muted comment-meta">{{ formatDate(thread.createdAt) }}</span>
              <NPopconfirm v-if="canDelete(thread)" @positive-click="removeComment(thread.id)">
                <template #trigger>
                  <button type="button" class="comment-action">删除</button>
                </template>
                删除后内容不可恢复，确定吗？
              </NPopconfirm>
            </header>

            <p v-if="thread.deleted" class="comment-body comment-deleted">该留言已删除</p>
            <p v-else class="comment-body">{{ thread.body }}</p>

            <footer class="comment-foot">
              <button
                v-if="!thread.deleted"
                type="button"
                class="comment-action"
                :class="{ 'is-liked': thread.likedByMe }"
                @click="likeComment(thread)"
              >
                👍 {{ thread.likeCount }}
              </button>
              <button
                v-if="!thread.deleted && isLoggedIn"
                type="button"
                class="comment-action"
                @click="replyTo = replyTo === thread.id ? null : thread.id"
              >
                {{ replyTo === thread.id ? '收起' : '回复' }}
              </button>
            </footer>

            <div v-if="replyTo === thread.id" class="comment-reply-box">
              <NInput
                v-model:value="replyDraft"
                type="textarea"
                placeholder="回复这条留言…"
                :maxlength="1000"
                :autosize="{ minRows: 2, maxRows: 4 }"
              />
              <div class="comment-composer-foot">
                <span />
                <NButton
                  size="small"
                  type="primary"
                  :disabled="posting || replyDraft.trim().length === 0"
                  :loading="posting"
                  @click="post(thread.id)"
                >
                  发送
                </NButton>
              </div>
            </div>

            <div v-if="thread.replies.length > 0" class="comment-replies">
              <div v-for="reply in thread.replies" :key="reply.id" class="comment comment-reply">
                <header class="comment-head">
                  <RouterLink :to="`/players/${reply.author.id}`" class="comment-author">
                    {{ reply.author.displayName }}
                  </RouterLink>
                  <span class="muted comment-meta">{{ formatDate(reply.createdAt) }}</span>
                  <NPopconfirm v-if="canDelete(reply)" @positive-click="removeComment(reply.id)">
                    <template #trigger>
                      <button type="button" class="comment-action">删除</button>
                    </template>
                    删除后内容不可恢复，确定吗？
                  </NPopconfirm>
                </header>
                <p v-if="reply.deleted" class="comment-body comment-deleted">该留言已删除</p>
                <p v-else class="comment-body">{{ reply.body }}</p>
                <footer v-if="!reply.deleted" class="comment-foot">
                  <button
                    type="button"
                    class="comment-action"
                    :class="{ 'is-liked': reply.likedByMe }"
                    @click="likeComment(reply)"
                  >
                    👍 {{ reply.likeCount }}
                  </button>
                </footer>
              </div>
            </div>
          </article>
        </div>
      </section>
    </template>
  </div>
</template>
