<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { ApiError, api } from '../lib/api';
import { loadMe } from '../lib/session';

const router = useRouter();
const mode = ref<'login' | 'register'>('login');
const submitting = ref(false);
const error = ref('');

const loginForm = ref({ identifier: '', password: '' });
const registerForm = ref({
  username: '',
  displayName: '',
  email: '',
  password: '',
  inviteCode: '',
});

async function submitLogin() {
  submitting.value = true;
  error.value = '';
  try {
    await api('/auth/login', { method: 'POST', body: loginForm.value });
    await loadMe();
    void router.push('/');
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '登录失败';
  } finally {
    submitting.value = false;
  }
}

async function submitRegister() {
  submitting.value = true;
  error.value = '';
  try {
    await api('/auth/register', { method: 'POST', body: registerForm.value });
    await loadMe();
    void router.push('/events');
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '注册失败';
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="container" style="max-width: 460px">
    <section class="card">
      <h1 class="section-title" style="margin-bottom: 18px">
        {{ mode === 'login' ? '登录 HIVE' : '加入 HIVE' }}
      </h1>

      <div class="nav-links" style="margin-bottom: 20px">
        <button
          type="button"
          class="nav-link"
          :class="{ active: mode === 'login' }"
          style="border: none; background: none; cursor: pointer"
          @click="mode = 'login'"
        >
          登录
        </button>
        <button
          type="button"
          class="nav-link"
          :class="{ active: mode === 'register' }"
          style="border: none; background: none; cursor: pointer"
          @click="mode = 'register'"
        >
          注册
        </button>
      </div>

      <p v-if="error" class="alert">{{ error }}</p>

      <form v-if="mode === 'login'" @submit.prevent="submitLogin">
        <label class="field">
          <span class="field-label">用户名或邮箱</span>
          <input v-model="loginForm.identifier" class="input" autocomplete="username" required />
        </label>
        <label class="field">
          <span class="field-label">密码</span>
          <input
            v-model="loginForm.password"
            class="input"
            type="password"
            autocomplete="current-password"
            required
          />
        </label>
        <button class="btn btn-primary" type="submit" :disabled="submitting" style="width: 100%">
          {{ submitting ? '登录中…' : '登录' }}
        </button>
      </form>

      <form v-else @submit.prevent="submitRegister">
        <label class="field">
          <span class="field-label">邀请码</span>
          <input
            v-model="registerForm.inviteCode"
            class="input"
            placeholder="由管理员在群里发放"
            required
          />
        </label>
        <label class="field">
          <span class="field-label">用户名（3-24 位，小写字母/数字/下划线）</span>
          <input v-model="registerForm.username" class="input" autocomplete="username" required />
        </label>
        <label class="field">
          <span class="field-label">显示名</span>
          <input v-model="registerForm.displayName" class="input" required />
        </label>
        <label class="field">
          <span class="field-label">邮箱</span>
          <input v-model="registerForm.email" class="input" type="email" required />
        </label>
        <label class="field">
          <span class="field-label">密码（至少 10 位）</span>
          <input
            v-model="registerForm.password"
            class="input"
            type="password"
            autocomplete="new-password"
            minlength="10"
            required
          />
        </label>
        <button class="btn btn-primary" type="submit" :disabled="submitting" style="width: 100%">
          {{ submitting ? '注册中…' : '创建账号' }}
        </button>
        <p class="muted" style="font-size: 12px; margin-top: 14px">
          HIVE 采用邀请制。Steam 绑定是可选的——你也可以稍后在个人档案里手动填写段位。
        </p>
      </form>
    </section>
  </div>
</template>
