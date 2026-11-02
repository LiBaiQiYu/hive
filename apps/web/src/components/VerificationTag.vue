<script setup lang="ts">
/**
 * 身份验证徽章：Steam 认证 / 数字 ID / 自报。
 *
 * 只管"身份是谁证明的"，不管"段位从哪来"——后者是 rankSource，
 * 两者混在一起会让"已认证"没法解释。
 */
import { computed } from 'vue';
import {
  VERIFICATION_HINT,
  VERIFICATION_LABEL,
  VERIFICATION_TONE,
  verificationOf,
} from '../lib/verification';

const props = defineProps<{ verification: string | null | undefined }>();

const level = computed(() => verificationOf(props.verification));
</script>

<template>
  <span class="vtag" :data-tone="VERIFICATION_TONE[level]" :title="VERIFICATION_HINT[level]">
    {{ VERIFICATION_LABEL[level] }}
  </span>
</template>
