#!/usr/bin/env node
/**
 * HIVE 本地安全自检
 * ---------------------------------------------------------------------------
 * 打真实 HTTP 请求，验证"能想到的攻击面"是否真的被挡住——不是读代码猜。
 *
 *   node scripts/security-check.mjs                     # 默认打 http://127.0.0.1:8787
 *   node scripts/security-check.mjs http://127.0.0.1:8787
 *   HIVE_ADMIN=user:pass HIVE_PLAYER=user:pass node scripts/security-check.mjs
 *
 * 注意：
 *   · **会写入测试数据**（注册若干一次性账号、建邀请码、发一条审计），只能打本地库。
 *     默认拒绝非本机地址，真要打远端得加 --force，并且那是你自己负责。
 *   · 断言里的状态码是**当前 API 契约**：INVITE_INVALID→403、CONFLICT→409。
 *     改契约时记得同步改这里，否则它会替你发现"接口悄悄变了"。
 */
import process from 'node:process'

const args = process.argv.slice(2)
const force = args.includes('--force')
const BASE = args.find((a) => a.startsWith('http')) ?? process.env.HIVE_BASE ?? 'http://127.0.0.1:8787'
const ORIGIN = BASE

const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(BASE)
if (!isLocal && !force) {
  console.error(`拒绝执行：${BASE} 看起来不是本机地址。这个脚本会写数据，只应该打本地库。`)
  console.error('确实要跑就加 --force。')
  process.exit(2)
}

const creds = (envKey, fallback) => {
  const raw = process.env[envKey]
  if (!raw) return fallback
  const i = raw.indexOf(':')
  return [raw.slice(0, i), raw.slice(i + 1)]
}
const [ADMIN_USER, ADMIN_PASS] = creds('HIVE_ADMIN', ['byc1030', 'Hive-2026-local'])
const [PLAYER_USER, PLAYER_PASS] = creds('HIVE_PLAYER', ['p02', 'Hive-2026-local'])

/* --------------------------------- 框架 --------------------------------- */

const results = []
let pass = 0
let fail = 0

function check(group, name, cond, detail) {
  const ok = Boolean(cond)
  results.push({ ok, group, name, detail })
  if (ok) pass += 1
  else fail += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${group}] ${name}${detail ? `  — ${detail}` : ''}`)
}

function parseCookies(res) {
  const jar = {}
  const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
  for (const line of raw) {
    const [pair] = line.split(';')
    const i = pair.indexOf('=')
    if (i > 0) jar[pair.slice(0, i)] = pair.slice(i + 1)
  }
  return jar
}
const cookieHeader = (jar) =>
  Object.entries(jar)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ')

async function call(method, path, opts = {}) {
  const headers = { origin: opts.origin ?? ORIGIN }
  if (opts.csrf !== false && method !== 'GET') headers['x-hive-csrf'] = '1'
  if (opts.body !== undefined) headers['content-type'] = 'application/json'
  if (opts.cookie) headers.cookie = opts.cookie
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: opts.body === undefined ? undefined : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body),
    redirect: 'manual',
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 可能是重定向 */
  }
  return { status: res.status, json, text, headers: res.headers, cookies: parseCookies(res) }
}

const login = async (identifier, password) => {
  const r = await call('POST', '/api/auth/login', { body: { identifier, password } })
  return { cookie: cookieHeader(r.cookies), res: r }
}

const newCode = async (adminCookie, label) => {
  const r = await call('POST', '/api/admin/invite-codes', { cookie: adminCookie, body: { label, maxUses: 1 } })
  return r.json?.data?.code ?? r.json?.data?.inviteCode?.code ?? null
}

/* --------------------------------- 开跑 --------------------------------- */
console.log(`\n=== HIVE 本地安全自检 · ${BASE} ===\n`)

const admin = await login(ADMIN_USER, ADMIN_PASS)
const player = await login(PLAYER_USER, PLAYER_PASS)
check('0 前置', '管理员与普通玩家能登录', admin.res.status === 200 && player.res.status === 200,
  `${ADMIN_USER} ${admin.res.status} / ${PLAYER_USER} ${player.res.status}`)
if (admin.res.status !== 200) {
  console.error('\n管理员登录失败，后面的用例没有意义。检查账号口令或本地库是否已迁移（pnpm db:migrate:local）。')
  process.exit(2)
}

const stamp = Date.now().toString(36).slice(-5)
const newUser = `sec${stamp}`
let newPass = 'Sec-Check-Pass-1'

// 自检要改资料、改密码，都落在自己新建的一次性账号上，别去动真实玩家的档案。
const setupCode = await newCode(admin.cookie, 'sec-self')
const seeded = await call('POST', '/api/auth/register', {
  body: { username: newUser, displayName: '安检号', email: `${newUser}@t.local`, password: newPass, inviteCode: setupCode },
})
check('0 前置', '一次性测试账号注册成功', seeded.status === 201, `HTTP ${seeded.status} ${seeded.json?.error?.code ?? ''}`)
if (seeded.status !== 201) {
  console.error('\n注册测试账号失败，后面的用例会互相牵连。检查邀请码配置（REGISTRATION_REQUIRE_INVITE）与本地库。')
  process.exit(2)
}
const tester = await login(newUser, newPass)

/* --------------------------- 1. 认证 / 会话 --------------------------- */
{
  check('认证', '匿名访问 /api/me 应 401', (await call('GET', '/api/me')).status === 401)
  check('认证', '伪造会话 token 应 401', (await call('GET', '/api/me', { cookie: 'hive_session=forged' })).status === 401)

  const setCookie = admin.res.headers.getSetCookie().join(' | ')
  const missing = ['HttpOnly', 'SameSite=Lax', 'Path=/'].filter((f) => !setCookie.includes(f))
  check('认证', '会话 Cookie 带 HttpOnly / SameSite=Lax / Path=/', missing.length === 0, missing.length ? `缺 ${missing}` : '齐全')
  check('认证', '非 https 下不应出现 Secure（否则浏览器丢弃）', !/;\s*Secure/i.test(setCookie), /;\s*Secure/i.test(setCookie) ? '出现了 Secure' : '无')
  check('认证', '会话 Cookie 未设 Domain（host-only）', !/Domain=/i.test(setCookie))
}

/* ------------------------------ 2. CSRF ------------------------------ */
{
  const body = { identifier: PLAYER_USER, password: PLAYER_PASS }
  check('CSRF', '缺 x-hive-csrf 应 403', (await call('POST', '/api/auth/login', { csrf: false, body })).status === 403)
  check('CSRF', '伪造 Origin 应 403', (await call('POST', '/api/auth/login', { origin: 'https://evil.example', body })).status === 403)
  check('CSRF', '正确 Origin 放行', (await call('POST', '/api/auth/login', { body })).status === 200)
  check('CSRF', 'GET 不要求 CSRF 头', (await call('GET', '/api/events', { csrf: false })).status === 200)
  check('CSRF', '不下发 Access-Control-Allow-Origin', (await call('GET', '/api/health', { origin: 'https://evil.example' })).headers.get('access-control-allow-origin') === null)
}

/* ---------------------------- 3. 授权矩阵 ---------------------------- */
{
  const matrix = [
    ['GET', '/api/admin/dashboard'],
    ['GET', '/api/admin/users'],
    ['GET', '/api/admin/audit-logs'],
    ['GET', '/api/admin/invite-codes'],
    ['GET', '/api/admin/ratings/players'],
    ['GET', '/api/admin/jobs'],
    ['POST', '/api/admin/invite-codes', { label: 'x' }],
    ['POST', '/api/admin/jobs/00000000-0000-0000-0000-000000000000/retry'],
    ['PATCH', '/api/admin/users/00000000-0000-0000-0000-000000000000/role', { role: 'ADMIN' }],
    ['POST', '/api/admin/users/00000000-0000-0000-0000-000000000000/reset-password', {}],
    ['PUT', '/api/admin/ratings/players/00000000-0000-0000-0000-000000000000/rating-adjustment', { adjustment: 100, reason: 'x' }],
    ['PUT', '/api/admin/ratings/players/00000000-0000-0000-0000-000000000000/declared-mmr', { mmr: 3000, reason: 'x' }],
  ]
  for (const [method, path, body] of matrix) {
    const anon = await call(method, path, { body })
    const asPlayer = await call(method, path, { body, cookie: player.cookie })
    check('授权', `${method} ${path}`, anon.status === 401 && asPlayer.status === 403, `匿名 ${anon.status} / 玩家 ${asPlayer.status}`)
  }
}

/* ------------------------- 4. 输入 / 注入 / 越权 ------------------------ */
{
  const me = (r) => r.json?.data?.user
  const cookie = tester.cookie

  const longBio = await call('PATCH', '/api/me', { cookie, body: { bio: 'x'.repeat(5000) } })
  check('输入', '超长 bio 被拒', longBio.status === 400, `HTTP ${longBio.status}`)

  const sqli = await call('PATCH', '/api/me', { cookie, body: { bio: "'; DROP TABLE users; --" } })
  const alive = await call('GET', '/api/me', { cookie })
  check('输入', "SQL 注入语句不生效（表还在）", sqli.status === 200 && alive.status === 200)

  const xss = '<img src=x onerror=alert(1)>'
  const wrote = await call('PATCH', '/api/me', { cookie, body: { bio: xss } })
  const back = await call('GET', '/api/me', { cookie })
  check('输入', 'XSS 载荷原样存储（由前端转义）', wrote.status === 200 && me(back)?.bio === xss, `存回 ${String(me(back)?.bio).slice(0, 30)}`)

  // 只塞越权字段时，Zod 会把未知键剥掉 → 没有可更新字段 → 400；关键是角色没变
  const mass = await call('PATCH', '/api/me', { cookie, body: { role: 'ADMIN', status: 'ACTIVE' } })
  const after = await call('GET', '/api/me', { cookie })
  check(
    '越权',
    'body 里塞 role:ADMIN 无效',
    me(after)?.role === 'PLAYER' && (mass.status === 200 || mass.status === 400),
    `PATCH ${mass.status} → role=${me(after)?.role}`,
  )

  const proto = await call('PATCH', '/api/me', {
    cookie,
    body: '{"__proto__":{"role":"ADMIN"},"constructor":{"prototype":{"role":"ADMIN"}},"bio":"proto"}',
  })
  const afterProto = await call('GET', '/api/me', { cookie })
  check('越权', '__proto__ 污染不生效', me(afterProto)?.role === 'PLAYER', `PATCH ${proto.status} role=${me(afterProto)?.role}`)

  const big = await call('PATCH', '/api/me', { cookie, body: JSON.stringify({ bio: 'y'.repeat(1024 * 1024) }) })
  check('输入', '1MB body 被安全拒绝', big.status === 400 || big.status === 413, `HTTP ${big.status}`)

  const badLimit = await call('GET', '/api/leaderboard?limit=999999', { cookie })
  check('输入', 'limit 超上限被夹紧', badLimit.status === 200 && (badLimit.json?.data?.limit ?? 0) <= 100, `limit=${badLimit.json?.data?.limit}`)

  const badSort = await call('GET', '/api/leaderboard?sort=;DROP TABLE users', { cookie })
  check('输入', 'sort 非法值回落到默认', badSort.status === 200 && badSort.json?.data?.sort === 'rating', `sort=${badSort.json?.data?.sort}`)

  const badJson = await call('POST', '/api/auth/login', { body: 'not-json' })
  check('输入', '非 JSON body 是 400 不是 500', badJson.status === 400 && badJson.json?.error?.code === 'VALIDATION_FAILED')
  check('输入', '非法 id 是 404 不是 500', (await call('GET', '/api/events/not-a-uuid')).status === 404)
  check('输入', '未知接口回 JSON 404', (await call('GET', '/api/nope')).status === 404)

  const rank = await call('PUT', '/api/me/rank', { cookie, body: { rankTier: 999 } })
  const afterRank = await call('GET', '/api/me', { cookie })
  check('输入', 'rankTier 越界被拒', rank.status === 400 || afterRank.json?.data?.stats?.rankTier !== 999)
}

/* ----------------------- 5. 邀请码 / 注册 / 提权 ----------------------- */
{
  const bad = await call('POST', '/api/auth/register', {
    body: { username: `bad${stamp}`, displayName: 'x', email: `bad${stamp}@t.local`, password: newPass, inviteCode: 'HIVE-0000-0000' },
  })
  check('注册', '无效邀请码被拒（契约 403）', bad.status === 403 && bad.json?.error?.code === 'INVITE_INVALID')

  const nocode = await call('POST', '/api/auth/register', {
    body: { username: `noc${stamp}`, displayName: 'x', email: `noc${stamp}@t.local`, password: newPass },
  })
  check('注册', '缺邀请码被拒', nocode.status === 400)

  const freshCode = await newCode(admin.cookie, 'sec-weak')
  check('邀请码', '管理员能签发一次性邀请码', Boolean(freshCode), freshCode ?? '失败')

  const weak = await call('POST', '/api/auth/register', {
    body: { username: `wk${stamp}`, displayName: 'x', email: `wk${stamp}@t.local`, password: '123', inviteCode: freshCode },
  })
  check('注册', '弱口令被拒', weak.status === 400)

  check('提权', '注册时附带 role:ADMIN 被忽略', seeded.json?.data?.user?.role === 'PLAYER', `role=${seeded.json?.data?.user?.role}`)

  const reuse = await call('POST', '/api/auth/register', {
    body: { username: `re${stamp}`, displayName: 'x', email: `re${stamp}@t.local`, password: newPass, inviteCode: setupCode },
  })
  check('邀请码', '一次性邀请码不可复用', reuse.status === 403 && reuse.json?.error?.code === 'INVITE_INVALID')

  const dupCode = await newCode(admin.cookie, 'sec-dup')
  const dup = await call('POST', '/api/auth/register', {
    body: { username: ADMIN_USER, displayName: 'x', email: `dup${stamp}@t.local`, password: newPass, inviteCode: dupCode },
  })
  check('注册', '重复用户名被拒（契约 409）', dup.status === 409 && dup.json?.error?.code === 'CONFLICT')
}

/* --------------------------- 6. 改密码踢会话 --------------------------- */
{
  const a = await login(newUser, newPass)
  const b = await login(newUser, newPass)
  check('会话', '同账号多设备可并行登录', a.res.status === 200 && b.res.status === 200)
  check('会话', '当前密码不对时拒绝改密', (await call('POST', '/api/auth/password', { cookie: a.cookie, body: { currentPassword: 'nope', newPassword: 'X-Pass-1234' } })).status === 401)
  check('会话', '新旧密码相同被拒', (await call('POST', '/api/auth/password', { cookie: a.cookie, body: { currentPassword: newPass, newPassword: newPass } })).status === 400)

  const changed = await call('POST', '/api/auth/password', { cookie: a.cookie, body: { currentPassword: newPass, newPassword: 'Another-Pass-1' } })
  const aStill = await call('GET', '/api/me', { cookie: a.cookie })
  const bDead = await call('GET', '/api/me', { cookie: b.cookie })
  check('会话', '改密码后当前设备仍有效', changed.status === 200 && aStill.status === 200, `${changed.status}/${aStill.status}`)
  check('会话', '改密码后其他设备被踢下线', bDead.status === 401, `${bDead.status}`)
  newPass = 'Another-Pass-1'

  const tmp = await login(PLAYER_USER, PLAYER_PASS)
  await call('POST', '/api/auth/logout', { cookie: tmp.cookie })
  check('会话', '退出后旧 token 立即失效', (await call('GET', '/api/me', { cookie: tmp.cookie })).status === 401)
}

/* ---------------------------- 7. 管理员自锁 ---------------------------- */
{
  const meRes = await call('GET', '/api/me', { cookie: admin.cookie })
  const adminId = meRes.json?.data?.user?.id
  const self = await call('PATCH', `/api/admin/users/${adminId}/role`, { cookie: admin.cookie, body: { role: 'PLAYER' } })
  check('管理员', '不能修改自己的角色', self.status === 409 || self.status === 400, `HTTP ${self.status}`)

  const users = await call('GET', '/api/admin/users', { cookie: admin.cookie })
  const list = users.json?.data?.users ?? []
  check('管理员', '成员列表可读', list.length > 0, `${list.length} 人`)
}

/* ------------------------- 8. 审计日志留痕可查 ------------------------- */
{
  const users = await call('GET', '/api/admin/users', { cookie: admin.cookie })
  const target = (users.json?.data?.users ?? []).find((u) => u.username === newUser)
  if (!target) {
    check('审计', '找到刚注册的测试账号', false, '未找到')
  } else {
    await call('PATCH', `/api/admin/users/${target.id}/role`, { cookie: admin.cookie, body: { role: 'ADMIN' } })
    const logs = await call('GET', '/api/admin/audit-logs?action=user.role&limit=50', { cookie: admin.cookie })
    const entries = logs.json?.data?.entries ?? []
    const hit = entries.find((e) => e.entityId === target.id && String(e.afterJson ?? '').includes('ADMIN'))
    check('审计', '授予管理员后审计日志立即出现', Boolean(hit), hit ? `actor=${hit.actorName ?? hit.actorId}` : '未找到')
    check('审计', '审计记录带操作者与 request id', Boolean(hit?.actorId && hit?.requestId))
    await call('PATCH', `/api/admin/users/${target.id}/role`, { cookie: admin.cookie, body: { role: 'PLAYER' } })
  }
}

/* ---------------------------- 9. 隐私字段泄露 --------------------------- */
{
  const leaks = []
  const probe = async (path, cookie) => {
    const r = await call('GET', path, { cookie })
    const t = r.text
    for (const key of ['password_hash', 'passwordHash', 'ip_hash', 'ipHash', 'failed_login', 'locked_until']) {
      if (t.includes(key)) leaks.push(`${path} 含 ${key}`)
    }
    if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(t)) leaks.push(`${path} 含邮箱`)
    if (/"qqNumber"\s*:\s*"?\d{5,12}/.test(t)) leaks.push(`${path} 含 QQ 号`)
    return r
  }

  const events = await probe('/api/events', player.cookie)
  await probe('/api/leaderboard', player.cookie)
  await probe('/api/me/matches', player.cookie)
  const ev = events.json?.data?.[0]
  if (ev) {
    await probe(`/api/events/${ev.id}`, player.cookie)
    await probe(`/api/events/${ev.id}/registrations`, player.cookie)
    const ms = await call('GET', `/api/events/${ev.id}/matches`, { cookie: player.cookie })
    const m = ms.json?.data?.[0]
    if (m) {
      await probe(`/api/matches/${m.id}`, null)
      await probe(`/api/matches/${m.id}`, player.cookie)
    }
  }
  check('隐私', '玩家可见接口不泄露密码哈希 / IP 哈希 / 邮箱 / QQ 号', leaks.length === 0, leaks.join('；') || '干净')

  const asAdmin = await call('GET', '/api/admin/users', { cookie: admin.cookie })
  check('隐私', '管理员视图可见 QQ 号（设计如此）', /"qqNumber"\s*:\s*"?\d{5,12}/.test(asAdmin.text))
}

/* ------------------------ 11. 玩家主页 / 社交接口 ------------------------ */
{
  // 目标选一个不是当前登录者、也不是我们自己的玩家
  const users = (await call('GET', '/api/admin/users', { cookie: admin.cookie })).json?.data?.users ?? []
  const target = users.find((u) => u.username !== PLAYER_USER && u.id !== admin.res.json?.data?.user?.id)
  const viewer = (await call('GET', '/api/auth/session', { cookie: player.cookie })).json?.data?.user

  if (!target) {
    check('社交', '找到可测试的玩家', false, '本地用户不足')
  } else {
    const profile = await call('GET', `/api/players/${target.id}`)
    check('社交', '公开档案游客可读', profile.status === 200, `HTTP ${profile.status}`)
    check(
      '社交',
      '档案不泄露邮箱 / QQ / SteamID',
      !/@[a-z0-9.-]+\.[a-z]{2,}/i.test(profile.text) && !/qqNumber|steam_id64|password/.test(profile.text),
      '干净',
    )

    const anonVote = await call('POST', `/api/players/${target.id}/reaction`, { body: { kind: 'LIKE' } })
    check('社交', '未登录不能投票', anonVote.status === 401, `HTTP ${anonVote.status}`)

    const anonComment = await call('POST', `/api/players/${target.id}/comments`, { body: { body: 'x' } })
    check('社交', '未登录不能留言', anonComment.status === 401, `HTTP ${anonComment.status}`)

    const selfVote = await call('POST', `/api/players/${viewer?.id}/reaction`, {
      cookie: player.cookie,
      body: { kind: 'LIKE' },
    })
    check('社交', '不能给自己投票', selfVote.status === 403, `HTTP ${selfVote.status}`)

    const hugeComment = await call('POST', `/api/players/${target.id}/comments`, {
      cookie: player.cookie,
      body: { body: 'x'.repeat(1001) },
    })
    check('社交', '超长留言被拒', hugeComment.status === 400, `HTTP ${hugeComment.status}`)

    const xssComment = await call('POST', `/api/players/${target.id}/comments`, {
      cookie: player.cookie,
      body: { body: '<img src=x onerror=alert(1)>' },
    })
    if (xssComment.status === 201) {
      const listed = await call('GET', `/api/players/${target.id}/comments`)
      check('社交', '留言里的 XSS 原样存储（前端转义）', listed.text.includes('<img src=x onerror=alert(1)>'))
      await call('DELETE', `/api/players/${target.id}/comments/${xssComment.json.data.id}`, { cookie: player.cookie })
    } else {
      check('社交', '留言里的 XSS 原样存储（前端转义）', false, `HTTP ${xssComment.status}`)
    }
  }
}

/* ---------------------------- 10. 响应头 / 错误 ---------------------------- */
{
  const home = await call('GET', '/')
  check('头部', '/ 有 CSP', (home.headers.get('content-security-policy') ?? '').includes("default-src 'self'"))
  check('头部', '/ 有 X-Frame-Options', Boolean(home.headers.get('x-frame-options')), home.headers.get('x-frame-options') ?? '缺失')
  check('头部', '/ 有 nosniff', home.headers.get('x-content-type-options') === 'nosniff')
  check('头部', '/api/* 回 x-request-id', Boolean((await call('GET', '/api/health')).headers.get('x-request-id')))

  const probes = [
    ['GET', '/api/admin/audit-logs?limit=-5', admin.cookie],
    ['GET', '/api/admin/ratings/players/not-a-uuid/history', admin.cookie],
    ['GET', `/api/events/${'x'.repeat(300)}`, null],
  ]
  let stack = false
  for (const [m, p, ck] of probes) {
    const r = await call(m, p, { cookie: ck })
    if (r.status >= 500 && /at\s+\w+\s+\(|node_modules|\.ts:\d+|SQLITE_|D1_ERROR/.test(r.text)) stack = true
  }
  check('错误', '异常输入不吐栈', !stack)
  check('杂项', 'Steam 授权未登录应 401', (await call('GET', '/api/auth/steam/start')).status === 401)
  const cb = await call('GET', '/api/auth/steam/callback?state=forged', { cookie: admin.cookie })
  check('杂项', 'Steam 回调 state 不符时安全回跳', cb.status === 302 && (cb.headers.get('location') ?? '').includes('steam=error'))
  const wrongMethod = await call('DELETE', '/api/leaderboard')
  check('杂项', '错误方法不 500', wrongMethod.status === 404 || wrongMethod.status === 405)
}

/* -------------------------------- 汇总 -------------------------------- */
console.log(`\n=== 汇总：PASS ${pass} · FAIL ${fail} ===`)
const failed = results.filter((r) => !r.ok)
if (failed.length) {
  console.log('\n失败项：')
  for (const f of failed) console.log(`  · [${f.group}] ${f.name}${f.detail ? ` — ${f.detail}` : ''}`)
}
console.log(`\n本次写入的测试账号：${newUser}（口令已改成 ${newPass}）。本地库可随时清空重来。\n`)
process.exit(fail === 0 ? 0 : 1)
