<script setup lang="ts">
/**
 * 身份筛选：全部 / Steam 认证 / 数字 ID / 自报。
 * 带计数——点下去之前就知道还剩几个人，而不是点完发现是空的。
 */
import { NRadioButton, NRadioGroup } from 'naive-ui';
import { VERIFICATION_FILTER_OPTIONS, type VerificationFilter } from '../lib/verification';

defineProps<{
  modelValue: VerificationFilter;
  counts?: Record<VerificationFilter, number> | null;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: VerificationFilter] }>();
</script>

<template>
  <NRadioGroup
    :value="modelValue"
    size="small"
    class="vf-group"
    @update:value="emit('update:modelValue', $event as VerificationFilter)"
  >
    <NRadioButton
      v-for="option in VERIFICATION_FILTER_OPTIONS"
      :key="option.value"
      :value="option.value"
    >
      {{ option.label }}
      <span v-if="counts" class="vf-count">{{ counts[option.value] }}</span>
    </NRadioButton>
  </NRadioGroup>
</template>
