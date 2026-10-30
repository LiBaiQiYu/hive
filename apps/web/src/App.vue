<script setup lang="ts">
import { RouterLink, RouterView, useRoute } from 'vue-router';
import { logout, session } from './lib/session';
import { theme, toggleTheme } from './lib/theme';

const route = useRoute();
</script>

<template>
  <div class="shell">
    <header class="nav">
      <div class="container nav-inner">
        <RouterLink to="/" class="brand">
          <span class="brand-name">HIVE</span>
          <span class="brand-tag">Dota2 Community Warroom</span>
        </RouterLink>

        <nav class="nav-links">
          <RouterLink to="/" class="nav-link" :class="{ active: route.path === '/' }">首页</RouterLink>
          <RouterLink
            to="/events"
            class="nav-link"
            :class="{ active: route.path.startsWith('/events') }"
          >
            赛事
          </RouterLink>
          <span class="nav-link disabled" title="V1.0 暂未开放">排行榜</span>
          <span class="nav-link disabled" title="V1.0 暂未开放">战绩</span>
          <RouterLink to="/me" class="nav-link" :class="{ active: route.path === '/me' }">
            我的
          </RouterLink>
          <RouterLink
            v-if="session.me?.user.role === 'ADMIN'"
            to="/admin"
            class="nav-link"
            :class="{ active: route.path.startsWith('/admin') }"
          >
            后台
          </RouterLink>
        </nav>

        <div class="nav-right">
          <button
            class="btn btn-ghost"
            type="button"
            :title="theme === 'dark' ? '切换到浅色模式' : '切换到深色模式'"
            @click="toggleTheme"
          >
            {{ theme === 'dark' ? '☀ 浅色' : '☾ 深色' }}
          </button>
          <template v-if="session.me">
            <span class="muted" style="font-size: 13px">{{ session.me.user.displayName }}</span>
            <button class="btn btn-ghost" type="button" @click="logout">退出</button>
          </template>
          <RouterLink v-else to="/login" class="btn btn-primary">登录 / 注册</RouterLink>
        </div>
      </div>
    </header>

    <main class="main">
      <RouterView />
    </main>

    <footer class="footer">HIVE · SAME GAME, BETTER COMMUNITY</footer>
  </div>
</template>
