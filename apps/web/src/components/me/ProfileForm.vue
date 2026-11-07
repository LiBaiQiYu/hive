<script setup lang="ts">
/**
 * 个人资料表单（账号设置页）。
 *
 * 从「我的」拆出来的理由：显示名 / QQ / 简介是半年动一次的东西，
 * 和评分、卡面那种"改了立刻看到效果"的日常操作不该挤在同一页。
 * 显示名和简介会出现在玩家卡上，所以保存后要 loadMe 让全站拿到新值。
 *
 * 邮箱也在这一页，但它是例外：改邮箱要额外输当前密码，因为它决定
 * "密码找回收信到哪"——只凭一个已登录的会话就能改收件地址是不安全的。
 */
import { computed, ref, watch } from 'vue';
import { NButton, NInput, useMessage } from 'naive-ui';
import HelpTip from '../HelpTip.vue';
import CurrentPasswordInput from '../CurrentPasswordInput.vue';
import { ApiError, api } from '../../lib/api';
import { loadMe, session } from '../../lib/session';

const message = useMessage();

const profile = ref({ displayName: '', bio: '', qqNumber: '', email: '' });
const emailPassword = ref('');
const confirming = ref(false);
const profileSaving = ref(false);
const profileError = ref('');
const profileSaved = ref(false);

/**
 * 点一下「我确认能收到信」：写一个时间戳，顶部提醒条随之消失。
 * 它不验证任何东西——真正的验证是"用这个邮箱发一封信到 reset@"，
 * 这一步只是让人现在就意识到"密码找回走的是这个地址"。
 */
async function confirmEmail() {
  if (confirming.value) return;
  confirming.value = true;
  profileError.value = '';
  try {
    await api('/me/email/confirm', { method: 'POST' });
    if (session.me) session.me.user.emailConfirmed = true;
    message.success('已记录：这个邮箱能收到信');
  } catch (err) {
    profileError.value = err instanceof ApiError ? err.message : '操作失败';
  } finally {
    confirming.value = false;
  }
}

function fillProfile() {
  const user = session.me?.user;
  profile.value = {
    displayName: user?.displayName ?? '',
    bio: user?.bio ?? '',
    qqNumber: user?.qqNumber ?? '',
    email: user?.email ?? '',
  };
}

watch(() => session.me?.user, fillProfile, { deep: true, immediate: true });

/** 邮箱改了才需要当前密码；没改就不去打扰用户 */
const emailChanged = computed(
  () => profile.value.email.trim().toLowerCase() !== (session.me?.user.email ?? '').trim().toLowerCase(),
);

async function saveProfile() {
  profileError.value = '';
  profileSaved.value = false;
  if (emailChanged.value && !emailPassword.value) {
    profileError.value = '改邮箱需要输入当前密码';
    return;
  }
  profileSaving.value = true;
  try {
    const body: Record<string, unknown> = {
      displayName: profile.value.displayName,
      bio: profile.value.bio || null,
      qqNumber: profile.value.qqNumber || null,
    };
    if (emailChanged.value) {
      body.email = profile.value.email.trim();
      body.currentPassword = emailPassword.value;
    }

    await api('/me', { method: 'PATCH', body });
    await loadMe();
    emailPassword.value = '';
    profileSaved.value = true;
    message.success('资料已保存');
  } catch (err) {
    profileError.value = err instanceof ApiError ? err.message : '保存失败';
  } finally {
    profileSaving.value = false;
  }
}
</script>

<template>
  <section class="card section">
    <h2 class="card-title">
      个人资料
      <HelpTip
        title="哪些能改？"
        :steps="[
          '① 显示名、QQ、简介随时可以改',
          '② 邮箱改过一次要输当前密码——它决定密码找回的信寄到哪',
          '③ 用户名不可修改，它是登录凭据',
        ]"
      />
    </h2>

    <div class="id-row">
      <span class="stat-label">用户名</span>
      <span class="mono">
        @{{ session.me?.user.username }}
        <span class="muted" style="font-size: 11px">· 登录凭据，不可修改</span>
      </span>
    </div>

    <div
      class="grid"
      style="grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; margin-top: 16px"
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

    <div
      class="grid"
      style="grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; margin-top: 14px"
    >
      <label class="field" style="margin: 0">
        <span class="field-label">
          邮箱
          <HelpTip
            title="邮箱用来做什么？"
            :steps="[
              '① 忘记密码时，用这个邮箱发一封信到 reset@ 就能收到重置链接',
              '② 改成你常用的邮箱（QQ 邮箱、163 都行），收不到信就重置不了',
              '③ 改邮箱需要输入当前密码',
            ]"
          />
        </span>
        <NInput
          v-model:value="profile.email"
          placeholder="例如 123456789@qq.com"
          :input-props="{ autocomplete: 'email', spellcheck: 'false' }"
          size="medium"
        />
        <span v-if="session.me?.user.emailConfirmed" class="email-status email-status-ok">
          ✓ 已确认这个邮箱能收到信
        </span>
        <span v-else class="email-status">
          还没确认这个邮箱能收到信
          <NButton size="tiny" :loading="confirming" @click="confirmEmail">我确认能收到信</NButton>
        </span>
      </label>

      <label v-if="emailChanged" class="field" style="margin: 0">
        <span class="field-label">当前密码（改邮箱需要）</span>
        <CurrentPasswordInput v-model="emailPassword" placeholder="输入当前的登录密码" />
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
</template>
