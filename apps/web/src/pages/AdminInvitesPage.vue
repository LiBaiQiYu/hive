<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { ApiError, api, formatDate } from '../lib/api';

interface InviteCode {
  id: string;
  code: string;
  label: string | null;
  maxUses: number;
  usedCount: number;
  expiresAt: number | null;
  revokedAt: number | null;
  createdAt: number;
}

const codes = ref<InviteCode[]>([]);
const summary = ref({ total: 0, available: 0, used: 0 });
const loading = ref(true);
const busy = ref(false);
const error = ref('');
const message = ref('');

const form = ref({ label: '', maxUses: 1, expiresAt: '' });

async function refresh() {
  loading.value = true;
  try {
    const data = await api<{ codes: InviteCode[]; summary: typeof summary.value }>(
      '/admin/invite-codes',
    );
    codes.value = data.codes;
    summary.value = data.summary;
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '加载失败';
  } finally {
    loading.value = false;
  }
}

onMounted(refresh);

function toIso(local: string): string | undefined {
  if (!local) return undefined;
  const date = new Date(local);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

async function create() {
  busy.value = true;
  error.value = '';
  message.value = '';
  try {
    const created = await api<{ code: string }>('/admin/invite-codes', {
      method: 'POST',
      body: {
        label: form.value.label || undefined,
        maxUses: form.value.maxUses,
        expiresAt: toIso(form.value.expiresAt),
      },
    });
    message.value = `已生成 ${created.code}`;
    form.value = { label: '', maxUses: 1, expiresAt: '' };
    await refresh();
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '生成失败';
  } finally {
    busy.value = false;
  }
}

async function revoke(code: InviteCode) {
  busy.value = true;
  error.value = '';
  try {
    await api(`/admin/invite-codes/${code.id}/revoke`, { method: 'POST', body: {} });
    message.value = `已撤销 ${code.code}`;
    await refresh();
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '撤销失败';
  } finally {
    busy.value = false;
  }
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    message.value = `已复制 ${text}`;
  } catch {
    error.value = '剪贴板不可用，请手动选中复制';
  }
}

const now = Date.now();

function statusOf(code: InviteCode): { text: string; tag: string } {
  if (code.revokedAt !== null) return { text: '已撤销', tag: 'tag-other' };
  if (code.expiresAt !== null && code.expiresAt <= now) return { text: '已过期', tag: 'tag-other' };
  if (code.maxUses !== 0 && code.usedCount >= code.maxUses) return { text: '已用尽', tag: 'tag-other' };
  return { text: '可用', tag: 'tag-confirmed' };
}

const availableCodes = computed(() => codes.value.filter((c) => statusOf(c).text === '可用'));
</script>

<template>
  <div class="container">
    <div class="section-head">
      <RouterLink to="/admin" class="muted" style="font-size: 13px">← 返回后台</RouterLink>
    </div>

    <div class="section-head">
      <h1 class="section-title">邀请码</h1>
      <span class="muted" style="font-size: 13px">
        共 {{ summary.total }} 个 · 可用 {{ summary.available }} · 累计使用 {{ summary.used }} 次
      </span>
    </div>

    <p v-if="error" class="alert">{{ error }}</p>
    <p v-if="message" class="muted" style="margin: 0 0 14px">{{ message }}</p>

    <section class="card">
      <h2 class="card-title">生成新码</h2>
      <form class="admin-form" @submit.prevent="create">
        <label class="field" style="margin: 0">
          <span class="field-label">备注（给谁用的）</span>
          <input v-model="form.label" class="input" placeholder="例如：老王 / 群内公共码" maxlength="40" />
        </label>
        <label class="field" style="margin: 0">
          <span class="field-label">可用次数（0 = 不限）</span>
          <input v-model.number="form.maxUses" class="input" type="number" min="0" max="1000" />
        </label>
        <label class="field" style="margin: 0">
          <span class="field-label">过期时间（可选）</span>
          <input v-model="form.expiresAt" class="input" type="datetime-local" />
        </label>
        <button class="btn btn-primary" type="submit" :disabled="busy">
          {{ busy ? '生成中…' : '生成' }}
        </button>
      </form>
      <p class="muted" style="font-size: 12px; margin: 12px 0 0">
        默认一码一人。字符集去掉了 I / L / O / U，手抄到 QQ 里不会和 1 / 0 搞混。
      </p>
    </section>

    <section class="section">
      <div class="section-head">
        <h2 class="section-title">全部邀请码</h2>
        <button class="btn btn-ghost" type="button" :disabled="busy" @click="refresh">刷新</button>
      </div>

      <div v-if="loading" class="empty">加载中…</div>
      <div v-else-if="codes.length === 0" class="empty">还没有邀请码。</div>

      <div v-else class="card" style="padding: 8px 12px">
        <table class="table">
          <thead>
            <tr>
              <th>邀请码</th>
              <th>备注</th>
              <th class="num">使用</th>
              <th>状态</th>
              <th>创建时间</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="code in codes" :key="code.id">
              <td>
                <button
                  type="button"
                  class="mono"
                  style="
                    background: none;
                    border: none;
                    color: var(--gold-2);
                    cursor: pointer;
                    padding: 0;
                    font: inherit;
                  "
                  :title="'点击复制'"
                  @click="copy(code.code)"
                >
                  {{ code.code }}
                </button>
              </td>
              <td class="muted">{{ code.label ?? '—' }}</td>
              <td class="num mono">
                {{ code.usedCount }} / {{ code.maxUses === 0 ? '∞' : code.maxUses }}
              </td>
              <td>
                <span class="tag" :class="statusOf(code).tag">{{ statusOf(code).text }}</span>
              </td>
              <td class="muted">{{ formatDate(code.createdAt) }}</td>
              <td style="text-align: right">
                <button
                  v-if="code.revokedAt === null"
                  class="btn btn-ghost"
                  type="button"
                  :disabled="busy"
                  @click="revoke(code)"
                >
                  撤销
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p class="muted" style="font-size: 12px; margin-top: 12px">
        当前有 {{ availableCodes.length }} 个可用码。撤销后已注册的账号不受影响，只阻断后续使用。
      </p>
    </section>
  </div>
</template>
