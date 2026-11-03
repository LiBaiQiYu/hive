<script setup lang="ts">
/**
 * 更新日志弹窗。
 *
 * 只做一件事：把 lib/changelog.ts 里的条目排开给人看。
 * 数据不在组件里，是因为"版本号"和"这次改了什么"必须同源——
 * 版本号写在页脚、日志写在组件里，两处迟早对不上。
 */
import { NButton, NModal } from 'naive-ui';
import { APP_VERSION, RELEASES } from '../lib/changelog';

defineProps<{ show: boolean }>();
const emit = defineEmits<{ 'update:show': [boolean] }>();

const close = () => emit('update:show', false);
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    :bordered="false"
    style="width: 560px; max-width: calc(100vw - 32px)"
    @update:show="(value: boolean) => emit('update:show', value)"
  >
    <template #header>
      <div class="changelog-head">
        <span class="changelog-title">更新日志</span>
        <span class="changelog-badge mono">v{{ APP_VERSION }}</span>
      </div>
    </template>

    <div class="changelog-body">
      <section v-for="release in RELEASES" :key="release.version" class="changelog-release">
        <div class="changelog-meta">
          <span class="mono">v{{ release.version }}</span>
          <span class="muted">{{ release.date }}</span>
          <span v-if="release.version === APP_VERSION" class="pill pill-open">当前</span>
        </div>
        <ul class="changelog-items">
          <li v-for="(item, index) in release.items" :key="index">{{ item }}</li>
        </ul>
      </section>
    </div>

    <template #footer>
      <div class="changelog-foot">
        <span class="muted changelog-note">仅列示对外可见的变更</span>
        <NButton type="primary" @click="close">关闭</NButton>
      </div>
    </template>
  </NModal>
</template>
