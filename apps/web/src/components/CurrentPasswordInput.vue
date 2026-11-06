<script setup lang="ts">
/**
 * 「当前密码」输入框。
 *
 * 为什么不直接用 NInput：浏览器密码管理器看到 `autocomplete="current-password"`
 * 会把已保存的密码自动填进来，于是「证明是你本人」退化成「浏览器替你证明」——
 * 任何人走到一台没锁屏的电脑前，点一下就能改密码、改找回邮箱。
 *
 * 做法：初始 `readonly` 锁住（自动填充会跳过 readonly 字段），用户自己点进来
 * 或按 Tab 到它才解锁；同时把各家密码管理器的忽略标记都挂上。
 * 锁只解一次：解锁后就是普通输入框，不因为失焦再锁回去（否则手机上会弹出第二段键盘）。
 */
import { ref } from 'vue';
import { NInput } from 'naive-ui';

const props = withDefaults(defineProps<{ placeholder?: string }>(), {
  placeholder: '输入当前密码',
});

const model = defineModel<string>({ required: true });

const locked = ref(true);
function unlock() {
  locked.value = false;
}

const plainProps = {
  autocomplete: 'off',
  spellcheck: 'false',
  autocapitalize: 'off',
  'data-lpignore': 'true',
  'data-1p-ignore': 'true',
  'data-bwignore': 'true',
};
</script>

<template>
  <NInput
    v-model:value="model"
    type="password"
    show-password-on="click"
    :placeholder="props.placeholder"
    :input-props="{ ...plainProps, readonly: locked }"
    size="medium"
    @pointerdown="unlock"
    @focus="unlock"
  />
</template>
