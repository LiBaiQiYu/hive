<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
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
import ChangelogDialog from './components/ChangelogDialog.vue';
import EmailReminder from './components/EmailReminder.vue';
import { APP_VERSION } from './lib/changelog';
import { logout, session } from './lib/session';
import { theme, toggleTheme } from './lib/theme';
import { darkOverrides, lightOverrides } from './lib/ui';

const route = useRoute();
const router = useRouter();

/** 版权年份跟着系统走，别每年手改一次 */
const year = new Date().getFullYear();

/* ------------------------------------------------------------------ 版本 / 更新日志 */

const CHANGELOG_SEEN_KEY = 'hive-seen-version';
const showChangelog = ref(false);

/**
 * 版本号和上次看过的一致就什么都不做；不一致才弹一次，并立刻记账。
 * "立刻"是有意的：用户按 Esc 关掉也算看过了，不然每次刷新都再弹一次。
 */
onMounted(() => {
  let seen: string | null = null;
  try {
    seen = localStorage.getItem(CHANGELOG_SEEN_KEY);
  } catch {
    /* 隐私模式下 localStorage 不可用，那就别自动弹了 */
    return;
  }
  if (seen === APP_VERSION) return;
  showChangelog.value = true;
  try {
    localStorage.setItem(CHANGELOG_SEEN_KEY, APP_VERSION);
  } catch {
    /* 记不上就记不上，下次再弹一次而已 */
  }
});


const naiveTheme = computed(() => (theme.value === 'dark' ? darkTheme : null));
const overrides = computed(() => (theme.value === 'dark' ? darkOverrides : lightOverrides));

/**
 * 右上角用户菜单：这里是"和账号有关"的入口，顶栏不放的东西都在这儿。
 * 顶栏已经有「赛事」「我的」，所以不再重复赛事列表；
 * 「管理后台」只对 ADMIN 出现（路由守卫另有一道，这里只是不让人看见）。
 */
const userMenu = computed(() => {
  const items: Array<Record<string, unknown>> = [
    { label: '我的主页', key: '/me' },
    { label: '账号设置', key: '/settings' },
  ];
  if (session.me?.user.role === 'ADMIN') {
    items.push({ type: 'divider', key: 'divider-admin' });
    items.push({ label: '管理后台', key: '/admin' });
  }
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
                <RouterLink
                  to="/me"
                  class="nav-link"
                  :class="{ active: route.path === '/me' || route.path === '/settings' }"
                >
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
                    <!-- 窄屏会把用户名收起来，留这个图标当"账号菜单"的锚点 -->
                    <svg class="user-icon" viewBox="0 0 16 16" aria-hidden="true">
                      <circle
                        cx="8"
                        cy="5.4"
                        r="2.9"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.5"
                      />
                      <path
                        d="M2.6 14c.5-2.7 2.7-4.3 5.4-4.3s4.9 1.6 5.4 4.3"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.5"
                        stroke-linecap="round"
                      />
                    </svg>
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

          <EmailReminder />

          <main class="main">
            <!-- 路由切换做个淡入上浮：比"瞬间闪白"更像应用而不是网页 -->
            <RouterView v-slot="{ Component }">
              <Transition name="page" mode="out-in">
                <component :is="Component" :key="route.path" />
              </Transition>
            </RouterView>
          </main>

          <footer class="footer">
            <div class="container">
              <div class="footer-main">
                <div class="footer-brand">
                  <BrandLogo :height="22" />
                  <span class="footer-tag">Same game, better community</span>
                </div>

                <div class="footer-dev">
                  <span class="footer-dev-label">开发者</span>
                  <a
                    class="footer-link"
                    href="https://cwa1e.top"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    CarlosWhite_A1E
                    <span class="footer-ext" aria-hidden="true">↗</span>
                  </a>
                  <a
                    class="footer-link footer-link-sub"
                    href="https://cwa1e.top"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    cwa1e.top
                  </a>
                </div>

                <div class="footer-dev">
                  <span class="footer-dev-label">数据来源</span>
                  <a
                    class="footer-link"
                    href="https://stratz.com"
                    target="_blank"
                    rel="noopener noreferrer"
                    title="段位、天梯分与游戏昵称来自 STRATZ 的公开数据"
                  >
                    Powered by STRATZ
                    <span class="footer-ext" aria-hidden="true">↗</span>
                  </a>
                  <span class="footer-link footer-link-sub">DOTA2 公开数据</span>
                </div>
              </div>

              <div class="footer-bottom">
                <span>© {{ year }} HIVE</span>
                <span class="footer-dot" aria-hidden="true">·</span>
                <span>群内自用，非官方项目，与 Valve 无关</span>
                <button
                  type="button"
                  class="footer-ver mono"
                  title="看看这个版本更新了什么"
                  @click="showChangelog = true"
                >
                  v{{ APP_VERSION }}
                </button>
              </div>
            </div>
          </footer>

          <ChangelogDialog v-model:show="showChangelog" />
        </div>
      </NDialogProvider>
    </NMessageProvider>
  </NConfigProvider>
</template>
