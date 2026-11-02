<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { NButton, NPopconfirm, useMessage } from 'naive-ui';
import PageBack from '../components/PageBack.vue';
import { ApiError, api, formatDate } from '../lib/api';
import { session } from '../lib/session';

interface MemberRow {
  id: string;
  username: string;
  displayName: string;
  role: 'PLAYER' | 'ADMIN';
  status: string;
  qqNumber: string | null;
  createdAt: number;
  lastLoginAt: number | null;
  effective: number;
  registrations: number;
  appearances: number;
}

const users = ref<MemberRow[]>([]);
const loading = ref(true);
const busy = ref(false);
const error = ref('');
const toast = useMessage();

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

    <div v-if="loading" class="empty">加载中…</div>

    <div v-else class="card" style="padding: 8px 12px">
      <table class="table">
        <thead>
          <tr>
            <th>成员</th>
            <th class="num">评分</th>
            <th class="num">报名</th>
            <th class="num">出场</th>
            <th>最近登录</th>
            <th style="text-align: right">角色</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="user in users" :key="user.id">
            <td>
              {{ user.displayName }}
              <span class="muted" style="font-size: 12px; margin-left: 6px">@{{ user.username }}</span>
              <span v-if="user.id === meId" class="tag tag-other" style="margin-left: 6px">我</span>
            </td>
            <td class="num mono">{{ user.effective }}</td>
            <td class="num mono">{{ user.registrations }}</td>
            <td class="num mono">{{ user.appearances }}</td>
            <td class="muted" style="font-size: 12px">
              {{ user.lastLoginAt ? formatDate(user.lastLoginAt) : '从未' }}
            </td>
            <td style="text-align: right">
              <span v-if="user.id === meId" class="tag tag-other">管理员</span>
              <template v-else-if="user.role === 'ADMIN'">
                <NPopconfirm @positive-click="setRole(user, 'PLAYER')">
                  <template #trigger>
                    <NButton size="small" :disabled="busy">取消管理员</NButton>
                  </template>
                  取消后该成员将无法进入后台，确定吗？
                </NPopconfirm>
              </template>
              <NButton v-else size="small" type="primary" :disabled="busy" @click="setRole(user, 'ADMIN')">
                设为管理员
              </NButton>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
