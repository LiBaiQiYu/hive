<script setup lang="ts">
/**
 * 密码重置页：从邮件里的链接进来，用令牌设置新密码。
 *
 * 令牌只能从回信里拿到，所以这个页面不做"输入邮箱"那一步——
 * 申请入口在邮箱里（发信到 reset@），网页只负责"凭证换新密码"。
 */
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { RouterLink } from 'vue-router';
import { NButton, NInput } from 'naive-ui';
import { ApiError, api } from '../lib/api';
import { PASSWORD_RESET_EMAIL } from '../lib/contact';

const route = useRoute();
const token = computed(() => (typeof route.query.token === 'string' ? route.query.token : ''));

const checking = ref(true);
const valid = ref(false);
const target = ref<{ username: string | null; displayName: string | null } | null>(null);
const expiresAt = ref<number | null>(null);

const password = ref('');
const confirm = ref('');
const submitting = ref(false);
const done = ref(false);
const error = ref('');

const expiresText = computed(() => {
  if (!expiresAt.value) return '';
  return new Date(expiresAt.value).toLocaleString('zh-CN', { hour12: false });
});

onMounted(async () => {
  if (!token.value) {
    checking.value = false;
    return;
  }
  try {
    const data = await api<{
      valid: boolean;
      username?: string | null;
      displayName?: string | null;
      expiresAt?: number;
    }>(`/auth/reset-password/${encodeURIComponent(token.value)}`);
    valid.value = data.valid;
    if (data.valid) {
      target.value = { username: data.username ?? null, displayName: data.displayName ?? null };
      expiresAt.value = data.expiresAt ?? null;
    }
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '校验链接失败，请稍后重试';
  } finally {
    checking.value = false;
  }
});

async function submit() {
  if (password.value.length < 10) {
    error.value = '密码至少 10 位';
    return;
  }
  if (password.value !== confirm.value) {
    error.value = '两次输入的密码不一致';
    return;
  }
  submitting.value = true;
  error.value = '';
  try {
    await api('/auth/reset-password', {
      method: 'POST',
      body: { token: token.value, newPassword: password.value },
    });
    done.value = true;
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '重置失败，请重新申请';
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="container" style="max-width: 460px">
    <section class="card">
      <h1 class="section-title" style="margin-bottom: 18px">重置密码</h1>

      <p v-if="checking" class="muted" style="margin: 0">校验链接…</p>

      <template v-else-if="done">
        <p style="margin: 0 0 12px">密码已更新。其他设备上的登录已全部失效，请用新密码重新登录。</p>
        <RouterLink to="/login" class="btn btn-primary">去登录</RouterLink>
      </template>

      <template v-else-if="!valid">
        <p style="margin: 0 0 12px">
          {{ error || '这个链接无效或已经过期。' }}
        </p>
        <p class="muted" style="margin: 0 0 16px; font-size: 13px; line-height: 1.7">
          请用注册邮箱重新发一封空白邮件到
          <span class="mono">{{ PASSWORD_RESET_EMAIL }}</span>
          ，系统会回信带一个新链接（30 分钟内有效，只能使用一次）。
          收不到也可以联系管理员在后台重置。
        </p>
        <RouterLink to="/login" class="btn">返回登录</RouterLink>
      </template>

      <form v-else @submit.prevent="submit">
        <p class="muted" style="margin: 0 0 16px; font-size: 13px">
          正在为
          <b>{{ target?.displayName || target?.username }}</b>
          <span v-if="target?.username" class="mono">@{{ target.username }}</span>
          设置新密码。
          <template v-if="expiresText">链接 {{ expiresText }} 前有效。</template>
        </p>

        <label class="field">
          <span class="field-label">新密码</span>
          <NInput
            v-model:value="password"
            type="password"
            show-password-on="click"
            placeholder="至少 10 位"
            :input-props="{ autocomplete: 'new-password' }"
            size="large"
          />
        </label>

        <label class="field">
          <span class="field-label">再输一次</span>
          <NInput
            v-model:value="confirm"
            type="password"
            show-password-on="click"
            placeholder="确认新密码"
            :input-props="{ autocomplete: 'new-password' }"
            size="large"
          />
        </label>

        <p v-if="error" class="alert" style="margin: 0 0 12px">{{ error }}</p>

        <NButton type="primary" attr-type="submit" block :loading="submitting" :disabled="submitting">
          {{ submitting ? '提交中…' : '设置新密码' }}
        </NButton>
      </form>
    </section>
  </div>
</template>
