<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { NButton, NModal, NPopconfirm, useMessage } from 'naive-ui';
import PageBack from '../components/PageBack.vue';
import VerificationFilter from '../components/VerificationFilter.vue';
import VerificationTag from '../components/VerificationTag.vue';
import { ApiError, api, formatDate } from '../lib/api';
import {
  filterPlayers,
  sortPlayers,
  verificationCounts,
  type PlayerListRow,
  type PlayerSortKey,
} from '../lib/player-table';
import { rankLabel } from '../lib/rank';
import { session } from '../lib/session';
import { nextSort, type SortState } from '../lib/sort';
import type { VerificationFilter as FilterValue } from '../lib/verification';

interface MemberRow extends PlayerListRow {
  username: string;
  displayName: string;
  role: 'PLAYER' | 'ADMIN';
  status: string;
  qqNumber: string | null;
  createdAt: number;
  lastLoginAt: number | null;
  /** 身份验证：VERIFIED（Steam）/ CLAIMED（数字 ID）/ null（自报） */
  verification: string | null;
  rankSource: string | null;
  registrations: number;
  appearances: number;
}

/** 段位从哪来：管理员看这张表时要能立刻判断可信度 */
const SOURCE_LABEL: Record<string, string> = {
  OPENDOTA: '同步',
  STRATZ: '同步',
  SELF_REPORTED: '自报',
  ADMIN_SET: '管理员',
};

const users = ref<MemberRow[]>([]);
const loading = ref(true);
const busy = ref(false);
const error = ref('');
const toast = useMessage();

/** 默认不排序：保持"管理员在前、其余按注册时间"的服务端顺序，点表头才开始排 */
const filter = ref<FilterValue>('ALL');
const sort = ref<SortState<PlayerSortKey> | null>(null);
const counts = computed(() => verificationCounts(users.value));
const rows = computed(() => {
  const filtered = filterPlayers(users.value, filter.value);
  return sort.value ? sortPlayers(filtered, sort.value) : filtered;
});

function onSort(key: PlayerSortKey) {
  sort.value = sort.value ? nextSort(sort.value, key) : { key, direction: 'desc' };
}

const sortArrow = (key: PlayerSortKey) =>
  sort.value?.key === key ? (sort.value.direction === 'desc' ? '▼' : '▲') : '';

const meId = session.me?.user.id ?? null;

async function refresh() {
  loading.value = true;
  error.value = '';
  try {
    const data = await api<{ users: MemberRow[] }>('/admin/users');
    users.value = data.users;
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '加载失败';
  } finally {
    loading.value = false;
  }
}

onMounted(refresh);

async function setRole(user: MemberRow, role: 'PLAYER' | 'ADMIN') {
  busy.value = true;
  error.value = '';
  try {
    await api(`/admin/users/${user.id}/role`, { method: 'PATCH', body: { role } });
    toast.success(`${user.displayName} 已设为${role === 'ADMIN' ? '管理员' : '普通玩家'}`);
    await refresh();
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '修改失败';
    toast.error(error.value);
  } finally {
    busy.value = false;
  }
}

/* ------------------------------------------------------------ 重置密码 */
interface ResetInfo {
  displayName: string;
  username: string;
  password: string;
  sessionsRevoked: number;
}

const resetting = ref<string | null>(null);
const resetInfo = ref<ResetInfo | null>(null);

/**
 * 社区没有邮件服务（免费版也发不了信），所以"忘记密码"由管理员生成一次性临时口令，
 * 当面或在群里转交。响应里只出现这一次，页面关掉就再也拿不到。
 */
async function resetPassword(user: MemberRow) {
  resetting.value = user.id;
  try {
    const data = await api<ResetInfo & { id: string }>(`/admin/users/${user.id}/reset-password`, {
      method: 'POST',
      body: {},
    });
    resetInfo.value = data;
  } catch (err) {
    toast.error(err instanceof ApiError ? err.message : '重置失败');
  } finally {
    resetting.value = null;
  }
}

async function copyPassword() {
  const value = resetInfo.value?.password;
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    toast.success('临时密码已复制');
  } catch {
    toast.error('浏览器不允许自动复制，请手动选中');
  }
}
</script>

<template>
  <div class="container">
    <PageBack label="返回后台" />

    <div class="section-head">
      <h1 class="section-title">成员管理</h1>
      <NButton :disabled="busy" @click="refresh">刷新</NButton>
    </div>

    <p class="muted" style="font-size: 12px; margin: 0 0 14px">
      授予/撤销管理员都会写审计日志。不能改自己的角色，也不能把最后一名管理员降级。
    </p>

    <p v-if="error" class="alert">{{ error }}</p>

    <div class="list-tools">
      <VerificationFilter v-model="filter" :counts="counts" />
      <span class="muted list-tools-hint">点表头按段位 / 天梯分 / 评分排序</span>
    </div>

    <div v-if="loading" class="empty">加载中…</div>

    <div v-else-if="rows.length === 0" class="empty">这个筛选下没有成员。</div>

    <div v-else class="card" style="padding: 8px 12px">
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>昵称</th>
              <th>用户名</th>
              <th title="身份由谁证明：Steam / 数字 ID / 自报">验证</th>
              <th>角色</th>
              <th class="th-sort" @click="onSort('rankTier')">
                段位 <span class="sort-arrow">{{ sortArrow('rankTier') }}</span>
              </th>
              <th class="num th-sort" @click="onSort('mmr')">
                天梯分 <span class="sort-arrow">{{ sortArrow('mmr') }}</span>
              </th>
              <th class="num th-sort" @click="onSort('effective')">
                评分 <span class="sort-arrow">{{ sortArrow('effective') }}</span>
              </th>
              <th class="num">报名</th>
              <th class="num">出场</th>
              <th>最近登录</th>
              <th style="text-align: right">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="user in rows" :key="user.id">
              <td>
                {{ user.displayName }}
                <span v-if="user.id === meId" class="tag tag-other" style="margin-left: 6px">我</span>
              </td>
              <td class="mono muted" style="font-size: 12px">@{{ user.username }}</td>
              <td><VerificationTag :verification="user.verification" /></td>
              <td>
                <span v-if="user.role === 'ADMIN'" class="tag tag-other">管理员</span>
                <span v-else class="muted" style="font-size: 12px">玩家</span>
              </td>
              <td class="mono" style="white-space: nowrap">
                <template v-if="user.rankTier">
                  {{ rankLabel(user.rankTier) }}
                  <span v-if="SOURCE_LABEL[user.rankSource ?? '']" class="muted" style="font-size: 11px; margin-left: 5px">
                    {{ SOURCE_LABEL[user.rankSource ?? ''] }}
                  </span>
                </template>
                <span v-else class="muted" style="font-size: 12px">未采集</span>
              </td>
              <td class="num mono">{{ user.declaredMmr ?? '—' }}</td>
              <td class="num mono">{{ user.effective }}</td>
              <td class="num mono">{{ user.registrations }}</td>
              <td class="num mono">{{ user.appearances }}</td>
              <td class="muted" style="font-size: 12px">
                {{ user.lastLoginAt ? formatDate(user.lastLoginAt) : '从未' }}
              </td>
              <td style="text-align: right">
                <span v-if="user.id === meId" class="muted" style="font-size: 12px">—</span>
                <div v-else class="member-actions">
                  <template v-if="user.role === 'ADMIN'">
                    <NPopconfirm @positive-click="setRole(user, 'PLAYER')">
                      <template #trigger>
                        <NButton size="small" :disabled="busy">取消管理员</NButton>
                      </template>
                      取消后该成员将无法进入后台，确定吗？
                    </NPopconfirm>
                  </template>
                  <NButton
                    v-else
                    size="small"
                    type="primary"
                    :disabled="busy"
                    @click="setRole(user, 'ADMIN')"
                  >
                    设为管理员
                  </NButton>

                  <NPopconfirm @positive-click="resetPassword(user)">
                    <template #trigger>
                      <NButton
                        size="small"
                        :disabled="busy"
                        :loading="resetting === user.id"
                      >
                        重置密码
                      </NButton>
                    </template>
                    会立即让该玩家的所有设备下线，并生成一个新的临时密码（只显示一次）。确定吗？
                  </NPopconfirm>
                </div>
              </td>
            </tr>
        </tbody>
      </table>
      </div>
    </div>

    <!-- 临时密码只在这里出现一次；关掉窗口就再也拿不到 -->
    <NModal
      :show="resetInfo !== null"
      preset="card"
      :bordered="false"
      style="width: 460px; max-width: calc(100vw - 32px)"
      @update:show="(value: boolean) => { if (!value) resetInfo = null }"
    >
      <template #header>临时密码</template>

      <template v-if="resetInfo">
        <p class="muted" style="margin: 0 0 12px; font-size: 13px">
          已为 <b>{{ resetInfo.displayName }}</b>
          <span class="mono">@{{ resetInfo.username }}</span> 生成临时密码：
        </p>
        <div class="reset-password-box mono">{{ resetInfo.password }}</div>
        <p class="muted" style="margin: 12px 0 0; font-size: 12px; line-height: 1.7">
          只显示这一次，关闭后无法再次查看。请通过私聊转交本人，并提醒登录后到「账号设置」修改密码。
          <template v-if="resetInfo.sessionsRevoked > 0">
            已同时让 {{ resetInfo.sessionsRevoked }} 个登录会话下线。
          </template>
        </p>
      </template>

      <template #footer>
        <div style="display: flex; gap: 8px; justify-content: flex-end">
          <NButton @click="copyPassword">复制</NButton>
          <NButton type="primary" @click="resetInfo = null">已转交</NButton>
        </div>
      </template>
    </NModal>
  </div>
</template>
