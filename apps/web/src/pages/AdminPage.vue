<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import { NButton, NDatePicker, NInput, NSelect, useMessage } from 'naive-ui';
import HelpTip from '../components/HelpTip.vue';
import { ApiError, api, formatDate, STATUS_LABEL, type EventView } from '../lib/api';
import { SERVER_HELP, SERVER_OPTIONS, serverLabel, type ServerRegion } from '../lib/server';

const router = useRouter();
const events = ref<EventView[]>([]);
const loading = ref(true);
const creating = ref(false);
const error = ref('');
const message = useMessage();

/** 日期用毫秒时间戳存：NDatePicker 给的就是 number，省掉字符串来回转 */
const form = ref({
  title: '',
  capacity: 20,
  closesAt: null as number | null,
  startsAt: null as number | null,
  /** 服务器：默认全球服（Steam 直接启动的样子），国服要显式选 */
  serverRegion: 'GLOBAL' as ServerRegion,
});

const capacityOptions = [10, 20, 30].map((value) => ({
  label: `${value} 人 · ${value / 10} 场`,
  value,
}));

interface Dashboard {
  members: { active: number; admins: number; newThisMonth: number };
  events: { ongoing: number; total: number; openNow: number };
  registrations: { thisMonth: number };
  pendingPublish: number;
  jobs: { pending: number; running: number; dead: number; failed: number };
}

const dashboard = ref<Dashboard | null>(null);

onMounted(async () => {
  await refresh();
});

async function refresh() {
  loading.value = true;
  try {
    const [eventList, stats] = await Promise.all([
      api<EventView[]>('/events'),
      api<Dashboard>('/admin/dashboard').catch(() => null),
    ]);
    events.value = eventList;
    dashboard.value = stats;
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '加载失败';
  } finally {
    loading.value = false;
  }
}

/** 时间统一转成带时区的 ISO；null 表示没填 */
function toIso(ms: number | null): string | undefined {
  return ms ? new Date(ms).toISOString() : undefined;
}

async function create() {
  creating.value = true;
  error.value = '';
  try {
    const created = await api<EventView>('/admin/events', {
      method: 'POST',
      body: {
        title: form.value.title,
        capacity: form.value.capacity,
        registrationClosesAt: toIso(form.value.closesAt),
        startsAt: toIso(form.value.startsAt),
        serverRegion: form.value.serverRegion,
      },
    });
    form.value = {
      title: '',
      capacity: 20,
      closesAt: null,
      startsAt: null,
      serverRegion: 'GLOBAL',
    };
    message.success('赛事已创建');
    void router.push(`/admin/events/${created.id}`);
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '创建失败';
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <div class="container">
    <div class="section-head">
      <h1 class="section-title">管理后台</h1>
      <div style="display: flex; gap: 10px; align-items: center; flex-wrap: wrap">
        <NButton size="small" @click="router.push('/admin/members')">成员</NButton>
        <NButton size="small" @click="router.push('/admin/jobs')">队列</NButton>
        <NButton size="small" @click="router.push('/admin/audit')">审计</NButton>
        <NButton size="small" @click="router.push('/admin/ratings')">评分</NButton>
        <NButton size="small" @click="router.push('/admin/invites')">邀请码</NButton>
      </div>
    </div>

    <p v-if="error" class="alert">{{ error }}</p>

    <!-- 概览 -->
    <section v-if="dashboard" class="admin-stats">
      <div class="admin-stat">
        <div class="stat-label">成员</div>
        <div class="admin-stat-value mono">{{ dashboard.members.active }}</div>
        <div class="muted" style="font-size: 11px">
          {{ dashboard.members.admins }} 名管理员 · 本月新增 {{ dashboard.members.newThisMonth }}
        </div>
      </div>
      <div class="admin-stat">
        <div class="stat-label">赛事</div>
        <div class="admin-stat-value mono">{{ dashboard.events.total }}</div>
        <div class="muted" style="font-size: 11px">
          报名中 {{ dashboard.events.openNow }} · 进行中 {{ dashboard.events.ongoing }}
        </div>
      </div>
      <div class="admin-stat">
        <div class="stat-label">本月报名</div>
        <div class="admin-stat-value mono">{{ dashboard.registrations.thisMonth }}</div>
        <div class="muted" style="font-size: 11px">按报名时间统计</div>
      </div>
      <div class="admin-stat" :class="{ 'admin-stat-warn': dashboard.pendingPublish > 0 }">
        <div class="stat-label">待发布</div>
        <div class="admin-stat-value mono">{{ dashboard.pendingPublish }}</div>
        <div class="muted" style="font-size: 11px">
          {{ dashboard.pendingPublish > 0 ? '已封盘但还没发布阵容' : '没有积压' }}
        </div>
      </div>
      <div
        class="admin-stat"
        :class="{ 'admin-stat-warn': dashboard.jobs.dead > 0 }"
        style="cursor: pointer"
        @click="router.push('/admin/jobs')"
      >
        <div class="stat-label">后台任务</div>
        <div class="admin-stat-value mono">{{ dashboard.jobs.pending }}</div>
        <div class="muted" style="font-size: 11px">
          {{ dashboard.jobs.dead > 0 ? `${dashboard.jobs.dead} 个已判死` : '队列正常' }}
        </div>
      </div>
    </section>

    <section class="card">
      <h2 class="card-title">新建赛事</h2>
      <form class="admin-form" @submit.prevent="create">
        <label class="field" style="margin: 0">
          <span class="field-label">赛事名称</span>
          <NInput
            v-model:value="form.title"
            placeholder="HIVE 第 01 期周末内战"
            :maxlength="64"
            size="medium"
          />
        </label>
        <label class="field" style="margin: 0">
          <span class="field-label">
            目标人数
            <HelpTip
              title="目标人数怎么填？"
              :steps="[
                '① 必须是 10 的整数倍：20 = 2 场 × 10 人',
                '② 它是目标人数，不是座位数；报名期不生成比赛',
              ]"
              note="封盘时按 floor(已确认 / 10) 切场，余下的人进候补；人数卡在两档之间时要显式选开局策略。"
            />
          </span>
          <NSelect v-model:value="form.capacity" :options="capacityOptions" size="medium" />
        </label>
        <label class="field" style="margin: 0">
          <span class="field-label">
            服务器
            <HelpTip v-bind="SERVER_HELP" />
          </span>
          <NSelect v-model:value="form.serverRegion" :options="SERVER_OPTIONS" size="medium" />
        </label>
        <label class="field" style="margin: 0">
          <span class="field-label">
            报名截止
            <HelpTip
              title="不填会怎样？"
              :steps="[
                '① 不填 = 由你手动封盘，赛事卡上会显示「待定 · 管理员手动封盘」',
                '② 填了之后，赛事卡会显示倒计时，不足 24 小时转琥珀色',
              ]"
            />
          </span>
          <NDatePicker
            v-model:value="form.closesAt"
            type="datetime"
            clearable
            size="medium"
            format="yyyy-MM-dd HH:mm"
            time-picker-format="HH:mm"
            placeholder="选择日期时间"
          />
        </label>
        <label class="field" style="margin: 0">
          <span class="field-label">
            开赛时间
            <HelpTip
              title="为什么要填？"
              :steps="[
                '① 首页和赛事列表的赛事卡会把它放在最显眼的位置',
                '② 不填就显示「待定」，玩家不知道什么时候开打',
              ]"
            />
          </span>
          <NDatePicker
            v-model:value="form.startsAt"
            type="datetime"
            clearable
            size="medium"
            format="yyyy-MM-dd HH:mm"
            time-picker-format="HH:mm"
            placeholder="选择日期时间"
          />
        </label>
        <NButton type="primary" attr-type="submit" :disabled="creating" :loading="creating">
          {{ creating ? '创建中…' : '创建' }}
        </NButton>
      </form>
    </section>

    <section class="section">
      <div class="section-head">
        <h2 class="section-title">全部赛事</h2>
        <NButton @click="refresh">刷新</NButton>
      </div>

      <div v-if="loading" class="empty">加载中…</div>
      <div v-else-if="events.length === 0" class="empty">还没有赛事，先在上面创建一个。</div>

      <div v-else class="card" style="padding: 8px 12px">
        <table class="table">
          <thead>
            <tr>
              <th>赛事</th>
              <th>状态</th>
              <th class="num">报名</th>
              <th>报名截止</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="event in events" :key="event.id">
              <td>
                {{ event.title }}
                <span class="server-tag" :class="{ 'is-cn': event.serverRegion === 'CN' }">
                  {{ serverLabel(event.serverRegion) }}
                </span>
              </td>
              <td>
                <span class="pill pill-idle">{{ STATUS_LABEL[event.status] ?? event.status }}</span>
              </td>
              <td class="num">{{ event.confirmed }} / {{ event.capacity }}</td>
              <td class="muted">{{ formatDate(event.registrationClosesAt) }}</td>
              <td style="text-align: right">
                <RouterLink :to="`/admin/events/${event.id}`" class="btn btn-ghost">管理</RouterLink>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>
