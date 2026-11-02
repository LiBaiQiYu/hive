<script setup lang="ts">
/**
 * 账号设置：只放"和登录凭据有关"的东西——个人资料、密码。
 *
 * 从「我的」拆出来的理由见 docs/UI.md §2.1：
 * 评分 / 游戏身份 / 卡片外观 / 位置偏好是日常会改的档案，
 * 显示名、QQ、密码是半年动一次的低频表单，混在一起只会让改卡面要滚过三个密码框。
 */
import { RouterLink } from 'vue-router';
import PageBack from '../components/PageBack.vue';
import PasswordForm from '../components/me/PasswordForm.vue';
import ProfileForm from '../components/me/ProfileForm.vue';
</script>

<template>
  <div class="container">
    <PageBack to="/me" label="返回我的主页" />

    <div class="section-head me-head">
      <h1 class="section-title">账号设置</h1>
      <span class="muted" style="font-size: 13px">资料与登录凭据</span>
    </div>

    <nav class="settings-jump" aria-label="账号设置分区">
      <a href="#profile">个人资料</a>
      <a href="#security">账号安全</a>
    </nav>

    <div id="profile">
      <ProfileForm />
    </div>

    <div id="security">
      <PasswordForm />
    </div>

    <p class="settings-note muted">
      游戏身份（Steam / 数字 ID / 段位）、卡片外观和位置偏好属于玩家档案，在
      <RouterLink to="/me">我的主页</RouterLink> 里改。
    </p>
  </div>
</template>
