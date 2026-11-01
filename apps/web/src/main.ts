import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import App from './App.vue';
import './styles.css';
import './styles-me.css';
import './styles-admin.css';
import './styles-theme.css';
import './styles-card.css';
import './styles-skins.css';
import './styles-ui.css';
import './styles-hero.css';
import { loadMe } from './lib/session';
import { session } from './lib/session';
import { initTheme } from './lib/theme';
import HomePage from './pages/HomePage.vue';
import EventsPage from './pages/EventsPage.vue';
import EventDetailPage from './pages/EventDetailPage.vue';
import LoginPage from './pages/LoginPage.vue';
import MePage from './pages/MePage.vue';
import LeaderboardPage from './pages/LeaderboardPage.vue';
import RecordsPage from './pages/RecordsPage.vue';
import MatchPage from './pages/MatchPage.vue';

// 后台是少数人用的重页面（日期选择器等组件很占体积），按需加载
const AdminPage = () => import('./pages/AdminPage.vue');
const AdminEventPage = () => import('./pages/AdminEventPage.vue');
const AdminInvitesPage = () => import('./pages/AdminInvitesPage.vue');
const AdminRatingsPage = () => import('./pages/AdminRatingsPage.vue');
const AdminMembersPage = () => import('./pages/AdminMembersPage.vue');
const AdminJobsPage = () => import('./pages/AdminJobsPage.vue');
const AdminAuditPage = () => import('./pages/AdminAuditPage.vue');

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'home', component: HomePage },
    { path: '/events', name: 'events', component: EventsPage },
    { path: '/events/:id', name: 'event-detail', component: EventDetailPage },
    { path: '/me', name: 'me', component: MePage },
    { path: '/leaderboard', name: 'leaderboard', component: LeaderboardPage },
    { path: '/records', name: 'records', component: RecordsPage },
    { path: '/matches/:id', name: 'match', component: MatchPage },
    { path: '/login', name: 'login', component: LoginPage },
    { path: '/admin', name: 'admin', component: AdminPage, meta: { admin: true } },
    { path: '/admin/events/:id', name: 'admin-event', component: AdminEventPage, meta: { admin: true } },
    { path: '/admin/invites', name: 'admin-invites', component: AdminInvitesPage, meta: { admin: true } },
    { path: '/admin/ratings', name: 'admin-ratings', component: AdminRatingsPage, meta: { admin: true } },
    { path: '/admin/members', name: 'admin-members', component: AdminMembersPage, meta: { admin: true } },
    { path: '/admin/jobs', name: 'admin-jobs', component: AdminJobsPage, meta: { admin: true } },
    { path: '/admin/audit', name: 'admin-audit', component: AdminAuditPage, meta: { admin: true } },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
  scrollBehavior: () => ({ top: 0 }),
});

// 服务端已经用 requireAdmin 兜底，这里只是避免非管理员看到空页面。
// 进入后台前重新问一次服务端：内存里的 session 可能是旧的
// （会话过期、在别的标签页退出），只看缓存会让用户进到一个只剩 401 的页面。
// 注意：「我的」不做拦截 —— 未登录时页面自己会显示「请先 登录」，跳走反而突兀。
router.beforeEach(async (to) => {
  if (!session.ready || to.meta.admin) await loadMe();
  if (to.meta.admin && session.me?.user.role !== 'ADMIN') {
    return { path: '/login' };
  }
  return true;
});

// 会话「用着用着失效」（过期 / 在别的标签页退出）时把人送回登录页。
// 游客的 401 不算：那只是没登录，页面自己会提示，不该把人从「我的」踢走。
window.addEventListener('hive:session-expired', () => {
  if (router.currentRoute.value.path !== '/login') {
    void router.replace('/login');
  }
});

// 首屏就把会话拉回来：导航栏的登录态不该等到用户点"我的"才显示
initTheme();
void loadMe();

createApp(App).use(router).mount('#app');
