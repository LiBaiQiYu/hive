<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { NButton, NInput, useMessage } from 'naive-ui';
import HelpTip from '../components/HelpTip.vue';
import { ApiError, api } from '../lib/api';
import { loadMe } from '../lib/session';

const route = useRoute();
const router = useRouter();
const mode = ref<'login' | 'register'>('login');
const submitting = ref(false);
const error = ref('');
const message = useMessage();

/**
 * 登录后回跳（比如被守卫从 /settings 带来的）。
 * 只接受站内绝对路径，否则 ?redirect=https://evil 就成了开放重定向。
 */
const redirectTo = computed(() => {
  const raw = route.query.redirect;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : '';
});

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
    message.success('登录成功');
    void router.replace(redirectTo.value || '/');
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
    message.success('账号已创建，欢迎加入');
    void router.replace(redirectTo.value || '/events');
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
        <HelpTip
          v-if="mode === 'register'"
          title="邀请制"
          :steps="[
            '① 邀请码由管理员在群里发放，默认一码一人',
            '② 用户名注册后不可修改，它是登录凭据',
            '③ Steam 绑定是可选的，之后也可以手动填段位',
          ]"
          note="不绑定 Steam 同样能参与分队：手动填写的段位也计入评分，只是归属会显示「未验证」。"
        />
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
          <NInput
            v-model:value="loginForm.identifier"
            :input-props="{ autocomplete: 'username' }"
            placeholder="例如 byc1030"
            size="large"
          />
        </label>
        <label class="field">
          <span class="field-label">密码</span>
          <NInput
            v-model:value="loginForm.password"
            type="password"
            show-password-on="click"
            placeholder="输入密码"
            :input-props="{ autocomplete: 'current-password' }"
            size="large"
            @keyup.enter="submitLogin"
          />
        </label>
        <NButton type="primary" attr-type="submit" :disabled="submitting" :loading="submitting" block>
          {{ submitting ? '登录中…' : '登录' }}
        </NButton>
      </form>

      <form v-else @submit.prevent="submitRegister">
        <label class="field">
          <span class="field-label">邀请码</span>
          <NInput
            v-model:value="registerForm.inviteCode"
            placeholder="由管理员在群里发放"
            size="large"
          />
        </label>
        <label class="field">
          <span class="field-label">
            用户名
            <HelpTip
              title="用户名规则"
              :steps="['3–24 位，只能用小写字母、数字、下划线', '注册后不可修改——它是登录凭据', '显示名可以随时改，用户名不行']"
            />
          </span>
          <NInput
            v-model:value="registerForm.username"
            placeholder="3-24 位，小写字母 / 数字 / 下划线"
            :input-props="{ autocomplete: 'username' }"
            size="large"
          />
        </label>
        <label class="field">
          <span class="field-label">显示名</span>
          <NInput
            v-model:value="registerForm.displayName"
            placeholder="群里怎么称呼你"
            :maxlength="32"
            size="large"
          />
        </label>
        <label class="field">
          <span class="field-label">邮箱</span>
          <NInput v-model:value="registerForm.email" placeholder="you@example.com" size="large" />
        </label>
        <label class="field">
          <span class="field-label">
            密码
            <HelpTip
              title="密码要求"
              :steps="['至少 10 位', '服务端只存 PBKDF2 哈希，本站看不到明文']"
            />
          </span>
          <NInput
            v-model:value="registerForm.password"
            type="password"
            show-password-on="click"
            placeholder="至少 10 位"
            :input-props="{ autocomplete: 'new-password' }"
            size="large"
          />
        </label>
        <NButton type="primary" attr-type="submit" :disabled="submitting" :loading="submitting" block>
          {{ submitting ? '注册中…' : '创建账号' }}
        </NButton>
      </form>
    </section>
  </div>
</template>
