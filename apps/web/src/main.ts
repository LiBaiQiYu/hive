import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import App from './App.vue';
import './styles.css';
import './styles-me.css';
import './styles-admin.css';
import './styles-theme.css';
import './styles-card.css';
import { loadMe } from './lib/session';
import { session } from './lib/session';
import { initTheme } from './lib/theme';
import HomePage from './pages/HomePage.vue';
import EventsPage from './pages/EventsPage.vue';
import EventDetailPage from './pages/EventDetailPage.vue';
import LoginPage from './pages/LoginPage.vue';
import MePage from './pages/MePage.vue';
import AdminPage from './pages/AdminPage.vue';
import AdminEventPage from './pages/AdminEventPage.vue';
import AdminInvitesPage from './pages/AdminInvitesPage.vue';
import AdminRatingsPage from './pages/AdminRatingsPage.vue';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'home', component: HomePage },
    { path: '/events', name: 'events', component: EventsPage },
    { path: '/events/:id', name: 'event-detail', component: EventDetailPage },
    { path: '/me', name: 'me', component: MePage },
    { path: '/login', name: 'login', component: LoginPage },
    { path: '/admin', name: 'admin', component: AdminPage, meta: { admin: true } },
    { path: '/admin/events/:id', name: 'admin-event', component: AdminEventPage, meta: { admin: true } },
    { path: '/admin/invites', name: 'admin-invites', component: AdminInvitesPage, meta: { admin: true } },
    { path: '/admin/ratings', name: 'admin-ratings', component: AdminRatingsPage, meta: { admin: true } },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
  scrollBehavior: () => ({ top: 0 }),
});

// 服务端已经用 requireAdmin 兜底，这里只是避免非管理员看到空页面
router.beforeEach((to) => {
  if (to.meta.admin && session.me?.user.role !== 'ADMIN') {
    return { path: '/login' };
  }
  return true;
});

// 首屏就把会话拉回来：导航栏的登录态不该等到用户点"我的"才显示
initTheme();
void loadMe();

createApp(App).use(router).mount('#app');
