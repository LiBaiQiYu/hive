# HIVE 安全与生产可靠性检查

> 检查日期：2026-11-02 · 范围：仓库当前 `main`（`cc684b3`）· 方法：读代码 + 对本地 Worker 发真实请求验证

## 一句话结论

**鉴权、会话、CSRF、权限边界、密码存储这几块是可靠的，都有实测证据**；
剩下的风险不在代码逻辑，而在**运维层面**：双入口没关、没有自动备份、
静态资源的安全头缺失（已补，待发版）、以及几条"声明了却没生效"的清理任务。

---

## 一、本次发现并已修掉的问题

### 1. 会话 Cookie 硬编码 `Secure`（已修）

`auth.ts` / `steam-auth.ts` 里 `secure: true` 是写死的。用 `http://127.0.0.1:8787`
开发时，Chromium 对回环地址有例外所以能存下来，但换成局域网 IP 或任何非
localhost 的 http 地址，浏览器会直接丢弃 Cookie——表现就是"登录成功但还是未登录"。

→ 改为 `cookieSecure(env, c.req.url)`：看 `APP_ORIGIN` 的 scheme，只有 https 才加 `Secure`。

### 2. 页面一行安全响应头都没有（已修）

`run_worker_first: ["/api/*"]` 的代价：**HTML / JS / CSS 根本不经过 Worker**，
所以 `secureHeaders()` 只对 `/api/*` 生效。实测生产首页响应头只有 Cloudflare 自带的
`CF-RAY` / `NEL`，没有 CSP、没有 `X-Frame-Options`、没有 `nosniff`。

→ 新增 `apps/web/public/_headers`（资源层的约定文件，构建时拷进 `dist/`，边缘加头、不耗 Worker 调用）：

- `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; frame-ancestors 'none' …`
- `X-Frame-Options: DENY`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: strict-origin-when-cross-origin`、`Permissions-Policy`、`COOP`
- `/assets/*` 一年 immutable 缓存，`/` 保持 must-revalidate

`style-src` 必须留 `'unsafe-inline'`：Naive UI 用 css-render 运行时注入 `<style>`，Vue 的 `:style` 也是内联属性。
`script-src` 保持 `'self'` 是安全的——全站没有 `v-html` / `innerHTML` / `eval`，构建产物也没有内联脚本。

已用 headless Chrome 截图确认页面正常渲染（不是"头加了但白屏"）。

> ⚠️ 这两条要 `pnpm run deploy` 才会到生产。

---

## 二、已经生效、且有实测证据的控制

| 控制 | 实现 | 验证结果 |
| --- | --- | --- |
| CSRF | `SameSite=Lax` + 自定义头 `x-hive-csrf: 1` + Origin 白名单 | 缺头 → `403 FORBIDDEN`；伪造 `Origin: https://evil.example` → `403` |
| 会话 | 32 字节随机 token，库里只存 `sha256(token)`；HttpOnly / Path=/ / SameSite=Lax；72h 空闲超时、14 天绝对过期 | 带 Cookie → `/api/me` 200；不带 → 401 |
| 改密码 | `db.batch()` 原子地换哈希 + 撤销**其他**设备的所有会话 | 代码路径确认，事务内 |
| 登录锁定 | 5 次失败 → 锁 15 分钟；失败信息不区分"账号不存在"与"密码错" | 前 5 次 `UNAUTHENTICATED`，第 6 次 `RATE_LIMITED`；**锁定期间输入正确密码同样被拒** |
| 权限 | 所有 `/api/admin/*` 服务端 `requireAdmin(c)`，不依赖前端隐藏入口 | 普通玩家访问 6 个后台端点全部 `403`；未登录全部 `401`；未登录 `PATCH /api/me` → 401 |
| SQL 注入 | 全部 `prepare(...).bind(...)`；仅两处字符串拼接，均为固定列名/固定赋值片段 | 代码审查 |
| 密码存储 | PBKDF2-HMAC-SHA256 50,000 次 + 先做一层 HMAC(pepper)；常数时间比较；迭代数变化时登录成功静默 rehash | 单测 9 个通过 |
| 邀请码 | `crypto.getRandomValues` + 32 字符表，8 位 ≈ 40 bit；消耗用带守卫的 `UPDATE` 原子扣减，建号失败补偿 | 代码审查 |
| Steam OpenID | state Cookie（HMAC 签名）+ `op_endpoint` / `return_to` / `claimed_id` 校验 + 反向 `check_authentication`；DOTA 账号唯一约束 | 生产已跑通一次真实绑定 |
| XSS | 前端无 `v-html` / `innerHTML` / `eval`；Vue 默认转义；新增 CSP `script-src 'self'` | grep 全站零命中 |
| 密钥卫生 | 仓库无硬编码密钥；`.dev.vars`、`backups/` 均已 gitignore | `git grep` 零命中 |
| IP 隐私 | 不落原始 IP，只存 `sha256(ip + salt + 日期)` | 代码审查 |

---

## 三、还没解决的风险

### P1 · 上线前应该处理

1. **`workers_dev: true` 造成双入口**
   生产同时存在 `hive.<account>.workers.dev` 与将来的自定义域名。拿到域名后应改回 `false`
   并解开 `routes`，否则等于留了一个绕过"域名锁定"假设的旁路。
2. **没有自动备份**
   只有手动 `pnpm db:backup`。D1 控制台的 Time Travel 能按时间点回滚（保留期以当时套餐为准），
   但那是"补救"不是"备份"。建议每周固定导一次，扔进 `backups/`。
3. **本批修复尚未部署**
   生产现在跑的还是旧构建：既没有 `_headers`，也还是硬编码 `Secure` 的 Cookie。

### P2 · 建议近期做

4. ~~**`audit_logs` 永不清理**~~ —— 同批已修：每日维护现在按 `AUDIT_RETENTION_DAYS`
   （生产 365 天 / staging 30 天）裁剪 `audit_logs`。这个 var 之前声明了却没任何代码读它。
5. ~~**每日维护的会话清理条件写反了**~~ —— 同批已修：原条件是
   `DELETE FROM sessions WHERE expires_at < ? AND revoked_at IS NULL`，导致"用户主动退出/改密码"
   留下的撤销行永久堆积；现在只要过期就回收。

6. **登录没有 IP 维度的限流**
   单账号有锁定（5 次/15 分钟），但没有"同一 IP 高频尝试"的限制，也不会在撞库时挡住
   跨账号的低速喷洒。免费计划可以在 Cloudflare 控制台加一条 WAF 速率限制规则
   （`POST /api/auth/login`，按 IP，约 10 次/分钟），**不消耗 Worker CPU**，比在 Worker 里做更划算。
7. **会话 Cookie 建议改用 `__Host-` 前缀**
   `__Host-hive_session` 会强制"Secure + Path=/ + 不带 Domain"，从浏览器层面堵掉子域种 Cookie
   的可能。要等自定义域名、确认全站 https 之后再做（改名 = 现有会话全部失效，挑个没人用的时候）。

### P3 · 记录在案即可

8. **账号锁定可以拿来 DoS**：知道用户名就能把对方锁 15 分钟。15 人封闭社区可以接受。
9. **登录存在轻微时序差异**：账号不存在时不做 PBKDF2 直接返回，比"密码错"快约 5ms，
   理论上可枚举用户名。修复方式是给不存在的账号也跑一次假哈希——会多花 5ms CPU，收益很低。
10. **`staging` 环境是半成品**：`database_id: REPLACE_WITH_STAGING_D1_ID`、`routes` 指向
    `hive-staging.example.com`。误执行 `--env staging` 会**直接部署失败**（这是好事），但别当成能用。
11. **`STEAM_WEB_API_KEY` 为空**：Steam 绑定照样成功，只是拿不到昵称头像。不是安全问题。

---

## 四、生产可靠性

**配额（Workers 免费版）**：100,000 请求/日、每次请求 10ms CPU、3 条 Cron。

当前用量估算：15 人、每月 4–10 场。就算把每分钟的 Cron 算满（1,440 次/日）也只占 1.4%；
密码哈希实测 ~4.8ms，占 CPU 预算的一半，且有单测与实测边界记录（`docs/SMOKE-TEST.md`）。

**架构上的单点**（都是已知取舍，写在这里是为了别忘）：

- D1 是唯一数据源，没有读副本；D1 区域级故障 = 全站不可用。
- 没有 Queues，异步任务靠**每分钟**一次的 Cron 抽 `sync_jobs`，所以 OpenDota 同步最长延迟约 1 分钟；
  任务有租约 + 退避 + `DEAD` 状态，`/admin/jobs` 能手工重试。
- 静态资源走资源层，不消耗 Worker 调用——这也是为什么安全头要放到 `_headers`。

**数据层健康度**：19 表 / 239 列 / 44 索引 / 8 个迁移；
`pnpm db:check` 的 17 条不变量 + SQL↔Drizzle 一致性全部通过；97 个单测通过。

---

## 五、发版清单（这次改动到生产需要做什么）

```bash
pnpm typecheck && pnpm test && pnpm build && pnpm db:check   # 四条门禁
pnpm db:migrate:remote                                       # 生产库已在 0008，正常输出 No migrations to apply
pnpm run deploy
```

部署后自查：

```bash
curl -I https://<你的域名>/            # 应看到 content-security-policy / x-frame-options
curl -s https://<你的域名>/api/health
```

然后再去控制台做两件事：加那条登录速率限制规则、把 `workers_dev` 关掉（等域名就位）。
