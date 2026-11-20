<script setup lang="ts">
import SkeletonRows from '../components/SkeletonRows.vue';
/**
 * 后台 · 系统设置。
 *
 * 目前只有「注册方式」一个开关。它放在这里而不是写进 wrangler.jsonc：
 * 邀请制开/关是运营决定，不该为它发一次版，也不该出现"本地开了、线上还关着"。
 *
 * 交互上刻意要按一次「保存」：
 *   · 打开注册是"把门敞开"，误触一次就得发半天公告；
 *   · 保存前后都有明确的状态文字（当前 / 待保存），不会出现"我到底点没点"。
 */
import { computed, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { NButton, NSwitch, useMessage } from 'naive-ui';
import HelpTip from '../components/HelpTip.vue';
import PageBack from '../components/PageBack.vue';
import { ApiError, api } from '../lib/api';

interface AdminSettings {
  /** true = 邀请制；false = 开放注册 */
  registrationRequireInvite: boolean;
}

const saved = ref<AdminSettings | null>(null);
const draft = ref(false);
const loading = ref(true);
const saving = ref(false);
const error = ref('');
const toast = useMessage();

const dirty = computed(
  () => saved.value !== null && saved.value.registrationRequireInvite !== draft.value,
);
const modeLabel = computed(() => (draft.value ? '邀请制' : '开放注册'));

function apply(data: AdminSettings) {
  saved.value = data;
  draft.value = data.registrationRequireInvite;
}

onMounted(async () => {
  try {
    apply(await api<AdminSettings>('/admin/settings'));
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '加载设置失败';
  } finally {
    loading.value = false;
  }
});

async function save() {
  if (!dirty.value) return;
  saving.value = true;
  error.value = '';
  try {
    apply(
      await api<AdminSettings>('/admin/settings', {
        method: 'PUT',
        body: { registrationRequireInvite: draft.value },
      }),
    );
    toast.success(draft.value ? '已切换为邀请制' : '已切换为开放注册');
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '保存失败，请重试';
    // 失败时把草稿退回服务端的值：界面不能停在"看起来已经改了"的状态
    draft.value = saved.value?.registrationRequireInvite ?? false;
  } finally {
    saving.value = false;
  }
}

function revert() {
  draft.value = saved.value?.registrationRequireInvite ?? false;
}
</script>

<template>
  <div class="container">
    <PageBack label="返回后台" />

    <div class="section-head">
      <h1 class="section-title">系统设置</h1>
      <span class="muted" style="font-size: 13px">改完立即生效，不需要重新部署</span>
    </div>

    <p v-if="error" class="alert">{{ error }}</p>

    <section class="card">
      <h2 class="card-title">
        注册方式
        <HelpTip
          title="两种注册方式有什么区别？"
          :steps="[
            '① 开放注册：填完资料就能建号，注册页不显示邀请码输入框',
            '② 邀请制：必须带一个有效邀请码，码由管理员在「邀请码」页生成',
            '③ 切换只影响之后的新注册，已经建好的账号不受影响',
          ]"
          note="邀请制关闭时，已经发出去的码不会被消耗也不会失效；切回邀请制后照样能用。"
        />
      </h2>

      <SkeletonRows v-if="loading" />

      <template v-else>
        <div class="setting-row">
          <div class="setting-text">
            <div class="setting-name">
              邀请码注册
              <span class="tag" :class="draft ? 'tag-waitlist' : 'tag-confirmed'">
                {{ modeLabel }}
              </span>
              <span v-if="dirty" class="setting-dirty">有未保存的修改</span>
            </div>
            <p class="setting-desc muted">
              开启后，注册必须携带有效邀请码；关闭后任何人都能直接注册。
              注册页会按这个开关决定是否显示邀请码输入框。
            </p>
          </div>
          <NSwitch
            v-model:value="draft"
            :disabled="saving"
            size="large"
            :aria-label="draft ? '关闭邀请码注册（改为开放注册）' : '开启邀请码注册（改为邀请制）'"
          />
        </div>

        <div class="setting-actions">
          <NButton type="primary" :disabled="!dirty || saving" :loading="saving" @click="save">
            保存
          </NButton>
          <NButton v-if="dirty" :disabled="saving" @click="revert">撤销</NButton>
          <RouterLink to="/admin/invites" class="btn btn-ghost">管理邀请码</RouterLink>
        </div>

        <p class="setting-hint muted">
          想发码就先去「邀请码」页生成；注册方式改完立刻生效，注册页刷新后即按新规则显示。
        </p>
      </template>
    </section>
  </div>
</template>
