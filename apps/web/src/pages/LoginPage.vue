<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { NButton, NInput, useMessage } from 'naive-ui';
import HelpTip from '../components/HelpTip.vue';
import { ApiError, api } from '../lib/api';
import { fetchPublicConfig, type ResetFlow } from '../lib/config';
import { PASSWORD_RESET_EMAIL } from '../lib/contact';
import { loadMe } from '../lib/session';

const route = useRoute();
const router = useRouter();
const mode = ref<'login' | 'register'>('login');
const submitting = ref(false);
const error = ref('');
const message = useMessage();

/**
 * 注册方式（后台「系统设置」的开关）：
 *   null  = 还没从服务端拿到，先按"要邀请码"渲染，避免开放注册的人看到一闪而过的输入框；
 *   true  = 邀请制，显示并校验邀请码；
 *   false = 开放注册，整段邀请码逻辑（显示、校验、提交字段）都不参与。
 */
const requireInvite = ref<boolean | null>(null);

/**
 * 密码找回的形态（见 lib/config.ts）：
 *   null      = 还没拿到配置，先什么都不显示，避免文案闪一下再变；
 *   'self'    = 自建部署，页面里直接填邮箱发信；
 *   'inbound' = 线上免费版，提示用户发信到 reset@；
 *   'admin'   = 只能找管理员。
 */
const resetFlow = ref<ResetFlow | null>(null);
const resetEmail = ref('');
const resetSending = ref(false);
const resetSent = ref(false);

onMounted(async () => {
  const config = await fetchPublicConfig();
  requireInvite.value = config.registrationRequireInvite;
  resetFlow.value = config.passwordResetFlow;
});

/** 自助发信：只在 resetFlow === 'self' 时可用 */
async function requestReset() {
  const email = resetEmail.value.trim();
  if (!email) {
    message.warning('请填写注册邮箱');
    return;
  }
  resetSending.value = true;
  try {
    await api('/auth/reset-request', { method: 'POST', body: { email } });
    // 服务端对"邮箱不存在"也回 ok（避免枚举账号），所以这里统一提示"如果存在"
    resetSent.value = true;
  } catch (err) {
    message.error(err instanceof ApiError ? err.message : '发送失败，请稍后重试');
  } finally {
    resetSending.value = false;
  }
}

/**
 * 登录后回跳（比如被守卫从 /settings 带来的）。
 * 只接受站内绝对路径，否则 ?redirect=https://evil 就成了开放重定向。
 */
const redirectTo = computed(() => {
  const raw = route.query.redirect;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : '';
});

/* ==========================================================================
 * 校验
 *
 * 三条原则（之前那句笼统的「输入不合法」就是把它们全违反了）：
 *   1. 格式问题在这一端先拦，不让用户白等一个 400；
 *   2. 报错只出现在具体字段下面，说清"哪里不对、怎么改"；
 *   3. 只有失焦过（或提交过）的字段才显示错误，别一进页面就满屏飘红。
 * ========================================================================== */

const REGISTER_FIELDS = ['inviteCode', 'username', 'displayName', 'email', 'password'] as const;
type RegisterField = (typeof REGISTER_FIELDS)[number];

/** 与服务端 registerSchema 的规则保持一致；服务端仍然是最终裁判 */
const INVITE_RE = /^[A-Z0-9-]{6,16}$/;
const USERNAME_RE = /^[a-z0-9_]{3,24}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const loginForm = ref({ identifier: '', password: '' });
const loginError = reactive({ identifier: '', password: '' });

const registerForm = ref<Record<RegisterField, string>>({
  inviteCode: '',
  username: '',
  displayName: '',
  email: '',
  password: '',
});

const fieldError = reactive<Record<RegisterField, string>>({
  inviteCode: '',
  username: '',
  displayName: '',
  email: '',
  password: '',
});

/** 字段是否被用户碰过：碰过才显示错误 */
const touched = reactive<Record<RegisterField, boolean>>({
  inviteCode: false,
  username: false,
  displayName: false,
  email: false,
  password: false,
});

/** 邀请码：只留字母数字和短横线，并统一大写（用户小写输入也照样能过） */
function normalizeInvite(raw: string) {
  return raw.replace(/[^A-Za-z0-9-]/g, '').toUpperCase();
}

/**
 * 每条规则返回一句人话，空串表示通过。
 * 不用「输入不合法」这种话：它既没说是哪个字段，也没说该怎么改。
 */
const RULES: Record<RegisterField, (raw: string) => string> = {
  inviteCode: (raw) => {
    const value = normalizeInvite(raw);
    if (!value) return '请填写邀请码——由管理员在群里发放';
    if (!INVITE_RE.test(value)) return '邀请码是 6–16 位字母、数字或短横线，例如 HIVE-DEV-01';
    return '';
  },
  username: (raw) => {
    const value = raw.trim().toLowerCase();
    if (!value) return '请填写用户名';
    if (!USERNAME_RE.test(value)) return '用户名需 3-24 位，仅限小写字母、数字与下划线';
    return '';
  },
  displayName: (raw) => {
    const value = raw.trim();
    if (!value) return '请填写显示名——群里怎么称呼你';
    if (value.length > 32) return '显示名最多 32 个字';
    return '';
  },
  email: (raw) => {
    const value = raw.trim();
    if (!value) return '请填写邮箱';
    if (!EMAIL_RE.test(value)) return '邮箱格式不正确，例如 name@example.com';
    return '';
  },
  password: (raw) => {
    if (!raw) return '请设置密码';
    if (raw.length < 10) return '密码至少 10 位';
    if (raw.length > 72) return '密码最多 72 位';
    return '';
  },
};

function validateField(field: RegisterField) {
  fieldError[field] = RULES[field](registerForm.value[field]);
  return fieldError[field] === '';
}

function onRegisterBlur(field: RegisterField) {
  touched[field] = true;
  validateField(field);
}

/** 只有已经报错的字段才边打边复检：错误提示要随着修正一起消失 */
function revalidate(field: RegisterField) {
  if (touched[field] && fieldError[field]) validateField(field);
}

function setInvite(raw: string) {
  registerForm.value.inviteCode = normalizeInvite(raw);
  revalidate('inviteCode');
}

function setUsername(raw: string) {
  registerForm.value.username = raw.replace(/[^A-Za-z0-9_]/g, '').toLowerCase();
  revalidate('username');
}

function setDisplayName(raw: string) {
  registerForm.value.displayName = raw;
  revalidate('displayName');
}

function setEmail(raw: string) {
  registerForm.value.email = raw;
  revalidate('email');
}

function setPassword(raw: string) {
  registerForm.value.password = raw;
  revalidate('password');
}

function setLoginField(field: 'identifier' | 'password', raw: string) {
  loginForm.value[field] = raw;
  loginError[field] = '';
}

/** 把焦点移到第一个出错的字段：表单长的时候不用自己找 */
function focusField(selector: string) {
  document.querySelector<HTMLInputElement>(`${selector} input`)?.focus();
}

/** 服务端 zod 已经把"哪个字段不对"带回来了，就地标红，不要再弹一句笼统的提示 */
function applyServerFields(fields: Record<string, string[]> | undefined) {
  if (!fields) return false;
  let hit = false;
  for (const field of REGISTER_FIELDS) {
    const messages = fields[field];
    if (!messages || messages.length === 0) continue;
    fieldError[field] = messages[0] ?? '';
    touched[field] = true;
    hit = true;
  }
  return hit;
}

/** 切页签时把上一张表单的提示清掉：登录失败的红色横幅不该挂在注册页上 */
function switchMode(next: 'login' | 'register') {
  mode.value = next;
  error.value = '';
}

/**
 * 标题旁的帮助文案跟着注册方式走。
 * 只说"现在是什么规则"，不解释后台怎么切——玩家不需要知道这些。
 */
const registerHelp = computed(() =>
  requireInvite.value === false
    ? {
        title: '开放注册',
        steps: [
          '① 现在不需要邀请码，填完资料就能加入',
          '② 用户名注册后不可修改，它是登录凭据',
          '③ Steam 绑定是可选的，之后也可以手动填段位',
        ],
        note: '管理员随时可以切回邀请制；已经注册的账号不受影响。',
      }
    : {
        title: '邀请制',
        steps: [
          '① 邀请码由管理员在群里发放，默认一码一人',
          '② 用户名注册后不可修改，它是登录凭据',
          '③ Steam 绑定是可选的，之后也可以手动填段位',
        ],
        note: '不绑定 Steam 同样能参与分队：手动填写的段位也计入评分，只是归属会显示「未验证」。',
      },
);

/* ------------------------------------------------------------------ 登录 */

function submitLogin() {
  error.value = '';
  loginError.identifier = loginForm.value.identifier.trim() ? '' : '请填写用户名或邮箱';
  loginError.password = loginForm.value.password ? '' : '请填写密码';
  if (loginError.identifier) {
    focusField('[data-login="identifier"]');
    return;
  }
  if (loginError.password) {
    focusField('[data-login="password"]');
    return;
  }
  void doLogin();
}

async function doLogin() {
  submitting.value = true;
  error.value = '';
  try {
    await api('/auth/login', { method: 'POST', body: loginForm.value });
    await loadMe();
    message.success('登录成功');
    void router.replace(redirectTo.value || '/');
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '登录失败，请稍后再试';
  } finally {
    submitting.value = false;
  }
}

/* ------------------------------------------------------------------ 注册 */

async function submitRegister() {
  error.value = '';

  // 开放注册时邀请码整段不参与：不标红、不提交（服务端同样会忽略它）
  const fields = requireInvite.value
    ? REGISTER_FIELDS
    : REGISTER_FIELDS.filter((field) => field !== 'inviteCode');

  let firstInvalid: RegisterField | null = null;
  for (const field of fields) {
    touched[field] = true;
    if (!validateField(field) && !firstInvalid) firstInvalid = field;
  }
  if (firstInvalid) {
    focusField(`[data-field="${firstInvalid}"]`);
    return;
  }

  submitting.value = true;
  try {
    const body: Record<string, string> = {
      username: registerForm.value.username.trim().toLowerCase(),
      displayName: registerForm.value.displayName.trim(),
      email: registerForm.value.email.trim().toLowerCase(),
      password: registerForm.value.password,
    };
    if (requireInvite.value) body.inviteCode = normalizeInvite(registerForm.value.inviteCode);

    await api('/auth/register', { method: 'POST', body });
    await loadMe();
    message.success('账号已创建，欢迎加入');
    void router.replace(redirectTo.value || '/events');
  } catch (err) {
    if (err instanceof ApiError) {
      if (applyServerFields(err.fields)) {
        focusField(`[data-field="${REGISTER_FIELDS.find((field) => fieldError[field]) ?? 'inviteCode'}"]`);
        return;
      }
      // 服务端故意不区分"不存在 / 已过期 / 已用完"（防枚举），这里也只给一句合并的说法
      if (err.code === 'INVITE_INVALID') {
        // 另一种可能：管理员刚把开关切回邀请制（另一个标签页 / 手机），
        // 本地还以为开放注册。把输入框放出来，别把错误挂在一个看不见的字段上
        requireInvite.value = true;
        fieldError.inviteCode = '邀请码无效、已过期或已被用完，找管理员再要一个';
        touched.inviteCode = true;
        void nextTick(() => focusField('[data-field="inviteCode"]'));
        return;
      }
      error.value = err.message;
      return;
    }
    error.value = '注册失败，请稍后再试';
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="container" style="max-width: 460px">
    <section class="card">
      <h1 class="section-title" style="margin-bottom: 18px">
        {{ mode === 'login' ? '登录 HIVE' : '加入 HIVE' }}
        <HelpTip
          v-if="mode === 'register'"
          v-bind="registerHelp"
        />
      </h1>

      <div class="nav-links" style="margin-bottom: 20px">
        <button
          type="button"
          class="nav-link"
          :class="{ active: mode === 'login' }"
          style="border: none; background: none; cursor: pointer"
          @click="switchMode('login')"
        >
          登录
        </button>
        <button
          type="button"
          class="nav-link"
          :class="{ active: mode === 'register' }"
          style="border: none; background: none; cursor: pointer"
          @click="switchMode('register')"
        >
          注册
        </button>
      </div>

      <p v-if="mode === 'register'" class="form-note muted">带 <em class="req" aria-hidden="true">*</em> 的为必填。<template v-if="requireInvite">邀请码找管理员要；</template>用户名注册后不可改。</p>

      <p v-if="error" class="alert">{{ error }}</p>

      <form v-if="mode === 'login'" @submit.prevent="submitLogin">
        <label class="field" data-login="identifier">
          <span class="field-label">
            用户名或邮箱
            <em class="req" aria-hidden="true">*</em>
          </span>
          <NInput
            :value="loginForm.identifier"
            :status="loginError.identifier ? 'error' : undefined"
            :input-props="{ autocomplete: 'username', spellcheck: 'false' }"
            placeholder="例如 byc1030"
            size="large"
            @update:value="setLoginField('identifier', $event)"
          />
          <span v-if="loginError.identifier" class="field-error">{{ loginError.identifier }}</span>
        </label>
        <label class="field" data-login="password">
          <span class="field-label">
            密码
            <em class="req" aria-hidden="true">*</em>
          </span>
          <NInput
            :value="loginForm.password"
            :status="loginError.password ? 'error' : undefined"
            type="password"
            show-password-on="click"
            placeholder="输入密码"
            :input-props="{ autocomplete: 'current-password' }"
            size="large"
            @update:value="setLoginField('password', $event)"
            @keyup.enter="submitLogin"
          />
          <span v-if="loginError.password" class="field-error">{{ loginError.password }}</span>
        </label>
        <NButton type="primary" attr-type="submit" :disabled="submitting" :loading="submitting" block>
          {{ submitting ? '登录中…' : '登录' }}
        </NButton>
        <!-- 找回有三种形态，按服务端告知的 resetFlow 显示对应的一种 -->
        <div v-if="resetFlow === 'self'" class="login-hint reset-box">
          <template v-if="!resetSent">
            忘记密码？填注册邮箱，我们发一封带重置链接的邮件给你（30 分钟内有效）。
            <div class="reset-row">
              <NInput
                v-model:value="resetEmail"
                placeholder="注册邮箱"
                size="small"
                :input-props="{ autocomplete: 'email', type: 'email' }"
                @keyup.enter="requestReset"
              />
              <NButton size="small" :loading="resetSending" :disabled="resetSending" @click="requestReset">
                发送
              </NButton>
            </div>
          </template>
          <template v-else>
            如果 <span class="mono">{{ resetEmail }}</span> 是本站账号，重置链接已经发出，请查收（含垃圾箱）。
            收不到就联系管理员在「成员管理」里重置。
          </template>
        </div>
        <p v-else-if="resetFlow === 'inbound'" class="login-hint">
          忘记密码？用注册邮箱发一封空白邮件到
          <span class="mono">{{ PASSWORD_RESET_EMAIL }}</span>
          ，系统会回信带重置链接（30 分钟内有效）。
          收不到就联系管理员在「成员管理」里重置。
        </p>
        <p v-else-if="resetFlow === 'admin'" class="login-hint">
          忘记密码？请联系管理员在「成员管理」里重置。
        </p>
      </form>

      <form v-else @submit.prevent="submitRegister">
        <label v-if="requireInvite" class="field" data-field="inviteCode">
          <span class="field-label">
            邀请码
            <em class="req" aria-hidden="true">*</em>
          </span>
          <NInput
            :value="registerForm.inviteCode"
            :status="fieldError.inviteCode ? 'error' : undefined"
            :input-props="{ autocomplete: 'off', spellcheck: 'false', autocapitalize: 'characters' }"
            placeholder="例如 HIVE-DEV-01"
            size="large"
            @update:value="setInvite"
            @blur="onRegisterBlur('inviteCode')"
          />
          <span v-if="fieldError.inviteCode" class="field-error">{{ fieldError.inviteCode }}</span>
        </label>
        <label class="field" data-field="username">
          <span class="field-label">
            用户名
            <em class="req" aria-hidden="true">*</em>
            <HelpTip
              title="用户名规则"
              :steps="['3–24 位，只能用小写字母、数字、下划线', '注册后不可修改——它是登录凭据', '显示名可以随时改，用户名不行']"
            />
          </span>
          <NInput
            :value="registerForm.username"
            :status="fieldError.username ? 'error' : undefined"
            :input-props="{ autocomplete: 'username', spellcheck: 'false' }"
            placeholder="3-24 位，字母 / 数字 / 下划线"
            size="large"
            @update:value="setUsername"
            @blur="onRegisterBlur('username')"
          />
          <span v-if="fieldError.username" class="field-error">{{ fieldError.username }}</span>
        </label>
        <label class="field" data-field="displayName">
          <span class="field-label">
            显示名
            <em class="req" aria-hidden="true">*</em>
          </span>
          <NInput
            :value="registerForm.displayName"
            :status="fieldError.displayName ? 'error' : undefined"
            :maxlength="32"
            placeholder="群里怎么称呼你"
            size="large"
            @update:value="setDisplayName"
            @blur="onRegisterBlur('displayName')"
          />
          <span v-if="fieldError.displayName" class="field-error">{{ fieldError.displayName }}</span>
        </label>
        <label class="field" data-field="email">
          <span class="field-label">
            邮箱
            <em class="req" aria-hidden="true">*</em>
          </span>
          <NInput
            :value="registerForm.email"
            :status="fieldError.email ? 'error' : undefined"
            :input-props="{ autocomplete: 'email', spellcheck: 'false' }"
            placeholder="you@example.com"
            size="large"
            @update:value="setEmail"
            @blur="onRegisterBlur('email')"
          />
          <span v-if="fieldError.email" class="field-error">{{ fieldError.email }}</span>
        </label>
        <label class="field" data-field="password">
          <span class="field-label">
            密码
            <em class="req" aria-hidden="true">*</em>
            <HelpTip
              title="密码要求"
              :steps="['至少 10 位', '服务端只存 PBKDF2 哈希，本站看不到明文']"
            />
          </span>
          <NInput
            :value="registerForm.password"
            :status="fieldError.password ? 'error' : undefined"
            type="password"
            show-password-on="click"
            placeholder="至少 10 位"
            :input-props="{ autocomplete: 'new-password' }"
            size="large"
            @update:value="setPassword"
            @blur="onRegisterBlur('password')"
          />
          <span v-if="fieldError.password" class="field-error">{{ fieldError.password }}</span>
        </label>
        <NButton
          type="primary"
          attr-type="submit"
          :disabled="submitting || requireInvite === null"
          :loading="submitting"
          block
        >
          {{ submitting ? '注册中…' : '创建账号' }}
        </NButton>
      </form>
    </section>
  </div>
</template>
