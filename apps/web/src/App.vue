<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router';
import {
  NButton,
  NConfigProvider,
  NDialogProvider,
  NDropdown,
  NMessageProvider,
  darkTheme,
  dateZhCN,
  zhCN,
} from 'naive-ui';
import BrandLogo from './components/BrandLogo.vue';
import { logout, session } from './lib/session';
import { theme, toggleTheme } from './lib/theme';
import { darkOverrides, lightOverrides } from './lib/ui';

const route = useRoute();
const router = useRouter();

const naiveTheme = computed(() => (theme.value === 'dark' ? darkTheme : null));
const overrides = computed(() => (theme.value === 'dark' ? darkOverrides : lightOverrides));

/** 右上角用户菜单：路由跳转 + 退出，管理员多一项后台 */
const userMenu = computed(() => {
  const items: Array<Record<string, unknown>> = [
    { label: '我的主页', key: '/me' },
    { label: '赛事列表', key: '/events' },
  ];
  if (session.me?.user.role === 'ADMIN') items.push({ label: '管理后台', key: '/admin' });
  items.push({ type: 'divider', key: 'divider' });
  items.push({ label: '退出登录', key: 'logout' });
  return items;
});

async function onMenuSelect(key: string) {
  if (key === 'logout') {
    await logout();
    void router.push('/');
    return;
  }
  void router.push(key);
}
</script>

<template>
  <NConfigProvider
    :theme="naiveTheme"
    :theme-overrides="overrides"
    :locale="zhCN"
    :date-locale="dateZhCN"
  >
    <NMessageProvider placement="top" :duration="2600" :max="3">
      <NDialogProvider>
        <div class="shell">
          <header class="nav">
            <div class="container nav-inner">
              <RouterLink to="/" class="brand" aria-label="HIVE 首页">
                <BrandLogo :height="30" />
                <span class="brand-tag">Dota2 Community Warroom</span>
              </RouterLink>

              <nav class="nav-links">
                <RouterLink to="/" class="nav-link" :class="{ active: route.path === '/' }">
                  首页
                </RouterLink>
                <RouterLink
                  to="/events"
                  class="nav-link"
                  :class="{ active: route.path.startsWith('/events') }"
                >
                  赛事
                </RouterLink>
                <RouterLink
                  to="/leaderboard"
                  class="nav-link"
                  :class="{ active: route.path === '/leaderboard' }"
                >
                  排行榜
                </RouterLink>
                <RouterLink
                  to="/records"
                  class="nav-link"
                  :class="{ active: route.path === '/records' }"
                >
                  战绩
                </RouterLink>
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
                <!-- 主题切换：一个圆按钮，太阳/月亮交叉旋转淡出淡入 -->
                <NButton
                  quaternary
                  circle
                  class="theme-toggle-btn"
                  :title="theme === 'dark' ? '切换到浅色模式' : '切换到深色模式'"
                  :aria-label="theme === 'dark' ? '切换到浅色模式' : '切换到深色模式'"
                  @click="toggleTheme"
                >
                  <template #icon>
                    <span class="theme-toggle" :class="{ 'is-light': theme === 'light' }">
                      <svg
                        class="icon-sun"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.7"
                        stroke-linecap="round"
                      >
                        <circle cx="12" cy="12" r="4.1" />
                        <path
                          d="M12 2.6v2.1M12 19.3v2.1M2.6 12h2.1M19.3 12h2.1M5.3 5.3l1.5 1.5M17.2 17.2l1.5 1.5M18.7 5.3l-1.5 1.5M6.8 17.2l-1.5 1.5"
                        />
                      </svg>
                      <svg
                        class="icon-moon"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.7"
                        stroke-linejoin="round"
                      >
                        <path d="M20.4 14.2A8.5 8.5 0 1 1 9.8 3.6a7 7 0 0 0 10.6 10.6Z" />
                      </svg>
                    </span>
                  </template>
                </NButton>

                <NDropdown
                  v-if="session.me"
                  :options="userMenu"
                  trigger="click"
                  placement="bottom-end"
                  :show-arrow="true"
                  @select="onMenuSelect"
                >
                  <NButton quaternary class="user-chip">
                    <span class="user-name">{{ session.me.user.displayName }}</span>
                    <svg class="user-caret" viewBox="0 0 12 12" aria-hidden="true">
                      <path
                        d="M2.2 4.6 6 8.4l3.8-3.8"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.6"
                        stroke-linecap="round"
                      />
                    </svg>
                  </NButton>
                </NDropdown>

                <NButton v-else type="primary" @click="router.push('/login')">登录 / 注册</NButton>
              </div>
            </div>
          </header>

          <main class="main">
            <!-- 路由切换做个淡入上浮：比"瞬间闪白"更像应用而不是网页 -->
            <RouterView v-slot="{ Component }">
              <Transition name="page" mode="out-in">
                <component :is="Component" :key="route.path" />
              </Transition>
            </RouterView>
          </main>

          <footer class="footer">HIVE · SAME GAME, BETTER COMMUNITY</footer>
        </div>
      </NDialogProvider>
    </NMessageProvider>
  </NConfigProvider>
</template>
