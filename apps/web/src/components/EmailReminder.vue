<script setup lang="ts">
/**
 * 邮箱确认提醒条。
 *
 * 为什么要它：密码只能靠注册邮箱找回——用这个邮箱发一封空白邮件到 reset@，
 * 系统回信带一次性链接。但多数人的邮箱是随手填的，或者填完再没打开过，
 * 真忘了密码才发现收不到信。
 *
 * 没确认就一直挂在顶部（不做「关闭」按钮：关掉就等于默认他知道后果了，
 * 而这条提醒的价值恰恰在于一直能被看见）。点「我确认能收到信」即消失，
 * 换邮箱会重新出现。
 */
import { computed, ref } from 'vue';
import { NButton } from 'naive-ui';
import { ApiError, api } from '../lib/api';
import { loadMe, session } from '../lib/session';

const busy = ref(false);
const error = ref('');

const email = computed(() => session.me?.user.email ?? '');
const show = computed(() => Boolean(session.me) && session.me?.user.emailConfirmed !== true);

async function confirmEmail() {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await api('/me/email/confirm', { method: 'POST' });
    // 直接改本地状态，不重新拉 /me：少一次请求，也不会让页面闪一下
    if (session.me) session.me.user.emailConfirmed = true;
    window.dispatchEvent(new CustomEvent('hive:email-confirmed'));
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '操作失败，请稍后再试';
  } finally {
    busy.value = false;
  }
}

/** 兜底：如果 /me 里的邮箱是空的（老数据），提醒文案换成"去填一个" */
const missing = computed(() => email.value.trim().length === 0);
</script>

<template>
  <div v-if="show" class="email-banner" role="status">
    <div class="container email-banner-inner">
      <span class="email-banner-icon" aria-hidden="true">✉</span>
      <span class="email-banner-text">
        密码找回只靠注册邮箱。请确认
        <b v-if="!missing" class="mono">{{ email }}</b>
        <b v-else>你还没填邮箱</b>
        能收到信——否则忘记密码时只能找管理员重置。
      </span>
      <span v-if="error" class="email-banner-error">{{ error }}</span>
      <span class="email-banner-actions">
        <NButton size="tiny" type="primary" :loading="busy" :disabled="missing" @click="confirmEmail">
          我确认能收到信
        </NButton>
        <RouterLink to="/settings#profile" class="email-banner-link">
          {{ missing ? '去填邮箱' : '去改邮箱' }}
        </RouterLink>
      </span>
    </div>
  </div>
</template>
