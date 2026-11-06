<script setup lang="ts">
/**
 * 账号安全（账号设置页）。
 *
 * 目前只有改密码一件事——服务端在改密码时会吊销这台设备以外的所有会话，
 * 所以这里不需要额外的「退出所有设备」按钮（真要做，得先加接口）。
 *
 * 「当前密码」用 CurrentPasswordInput：浏览器密码管理器会把已存密码自动填进来，
 * 那样"验证是你本人"就等于验证"浏览器记得你的密码"，不能接受。
 */
import { onBeforeUnmount, ref } from 'vue';
import { NButton, NInput, useMessage } from 'naive-ui';
import HelpTip from '../HelpTip.vue';
import CurrentPasswordInput from '../CurrentPasswordInput.vue';
import { ApiError, api, formatDate } from '../../lib/api';
import { session } from '../../lib/session';

const message = useMessage();

const pwd = ref({ current: '', next: '', confirm: '' });
const pwdSaving = ref(false);
const pwdError = ref('');
const pwdMsg = ref('');

const roleLabel = () => (session.me?.user.role === 'ADMIN' ? '管理员' : '普通玩家');

/** 离开页面就把输过的密码从内存里清掉，别留在切回来还能看见的表单里 */
onBeforeUnmount(() => {
  pwd.value = { current: '', next: '', confirm: '' };
});

async function changePassword() {
  pwdError.value = '';
  pwdMsg.value = '';
  if (!pwd.value.current) {
    pwdError.value = '请先输入当前密码';
    return;
  }
  if (pwd.value.next.length < 10) {
    pwdError.value = '新密码至少 10 位';
    return;
  }
  if (pwd.value.next !== pwd.value.confirm) {
    pwdError.value = '两次输入的新密码不一致';
    return;
  }
  pwdSaving.value = true;
  try {
    await api('/auth/password', {
      method: 'POST',
      body: { currentPassword: pwd.value.current, newPassword: pwd.value.next },
    });
    pwd.value = { current: '', next: '', confirm: '' };
    pwdMsg.value = '密码已修改。其他设备上的登录已失效，这台保持在线。';
    message.success('密码已修改');
  } catch (err) {
    pwdError.value = err instanceof ApiError ? err.message : '修改失败';
  } finally {
    pwdSaving.value = false;
  }
}
</script>

<template>
  <section class="card section">
    <h2 class="card-title">
      账号安全
      <HelpTip
        title="改完密码会怎样？"
        :steps="[
          '① 其他设备会被强制下线，这台保持登录',
          '② 密码只存 PBKDF2 哈希，忘了只能重设，找不回来',
          '③ 当前密码必须自己输入，浏览器不会替你填',
        ]"
        note="改密码不会动评分、报名和已生成的阵容。"
      />
    </h2>

    <div
      class="grid"
      style="grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px"
    >
      <label class="field" style="margin: 0">
        <span class="field-label">当前密码</span>
        <CurrentPasswordInput v-model="pwd.current" placeholder="当前密码，需手动输入" />
      </label>
      <label class="field" style="margin: 0">
        <span class="field-label">
          新密码
          <HelpTip title="密码要求" :steps="['至少 10 位', '两次输入要一致']" />
        </span>
        <NInput
          v-model:value="pwd.next"
          type="password"
          show-password-on="click"
          placeholder="至少 10 位"
          :input-props="{ autocomplete: 'new-password' }"
          size="medium"
        />
      </label>
      <label class="field" style="margin: 0">
        <span class="field-label">再输一次新密码</span>
        <NInput
          v-model:value="pwd.confirm"
          type="password"
          show-password-on="click"
          placeholder="再输一次"
          :input-props="{ autocomplete: 'new-password' }"
          size="medium"
        />
      </label>
    </div>

    <p v-if="pwdError" class="alert" style="margin-top: 14px">{{ pwdError }}</p>
    <p v-if="pwdMsg" class="muted" style="margin-top: 14px">{{ pwdMsg }}</p>

    <div style="margin-top: 16px; display: flex; align-items: center; gap: 14px">
      <NButton type="primary" :disabled="pwdSaving" :loading="pwdSaving" @click="changePassword">
        {{ pwdSaving ? '提交中…' : '修改密码' }}
      </NButton>
    </div>

    <div class="account-meta">
      <div>
        <span class="stat-label">账号</span>
        <span class="mono">@{{ session.me?.user.username }}</span>
      </div>
      <div>
        <span class="stat-label">身份</span>
        <span class="mono">{{ roleLabel() }}</span>
      </div>
      <div>
        <span class="stat-label">注册于</span>
        <span class="mono">
          {{ session.me?.user.createdAt ? formatDate(session.me.user.createdAt) : '—' }}
        </span>
      </div>
    </div>
  </section>
</template>
