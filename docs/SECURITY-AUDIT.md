# HIVE 安全与生产可靠性检查

> 检查日期：2026-11-02 · 范围：仓库当前 `main` · 方法：读代码 + 对本地 Worker 发**真实 HTTP 请求**逐项验证
> + 依赖漏洞扫描（`pnpm audit`）+ git 历史密钥扫描

## 一句话结论

**鉴权、会话、CSRF、权限边界、密码存储、输入校验这几块是可靠的——61 项攻击用例全部按预期被挡住**；
剩下的风险不在代码逻辑，而在**运维层面**：双入口没关、没有自动备份、
安全头改完还没发版、登录缺 IP 维度限流、以及一个需要主版本升级才能关掉的 zod 依赖告警。

---

## 一、本次发现并修掉的问题

### 1. 会话 Cookie 硬编码 `Secure`

`auth.ts` / `steam-auth.ts` 里 `secure: true` 是写死的。用 `http://127.0.0.1:8787`
开发时 Chromium 对回环地址有例外所以能存下来，但换成局域网 IP 或任何非 localhost 的 http 地址，
浏览器会直接丢弃 Cookie——表现就是"登录成功但还是未登录"。

→ 改为 `cookieSecure(env, c.req.url)`：看 `APP_ORIGIN` 的 scheme，只有 https 才加 `Secure`。

### 2. 页面一行安全响应头都没有

`run_worker_first: ["/api/*"]` 的代价：**HTML / JS / CSS 根本不经过 Worker**，
所以 `secureHeaders()` 只对 `/api/*` 生效。实测生产首页响应头只有 Cloudflare 自带的
`CF-RAY` / `NEL`，没有 CSP、没有 `X-Frame-Options`、没有 `nosniff` —— 等于连点击劫持都不设防。

→ 新增 `apps/web/public/_headers`（资源层约定文件，构建时拷进 `dist/`，边缘加头、不消耗 Worker 调用）：

- `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; frame-ancestors 'none' …`
- `X-Frame-Options: DENY`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: strict-origin-when-cross-origin`、`Permissions-Policy`、`COOP`
- `/assets/*` 一年 immutable 缓存，`/` 保持 must-revalidate

`style-src` 必须留 `'unsafe-inline'`：Naive UI 用 css-render 运行时注入 `<style>`，Vue 的 `:style` 也是内联属性。
`script-src` 保持 `'self'` 是安全的——全站没有 `v-html` / `innerHTML` / `eval`，构建产物也没有内联脚本。
已用 headless Chrome 截图确认页面正常渲染（不是"头加了但白屏"）。

### 3. 每日维护里两处"声明了但没生效"

- `AUDIT_RETENTION_DAYS` 写在 `wrangler.jsonc` 里，**没有任何代码读它** → `audit_logs` 无限增长。
  现在每日维护按它 `DELETE`（生产 365 天 / staging 30 天）。
- 会话清理条件是 `DELETE FROM sessions WHERE expires_at < ? AND revoked_at IS NULL` ——
  「主动退出 / 改密码」留下的撤销行永远不回收。现在只要过期就删。

### 4. 依赖漏洞：drizzle-orm 升到 0.45.4

`pnpm audit --prod` 报 **HIGH**：`drizzle-orm < 0.45.2` 存在「SQL 标识符转义不当导致注入」
（[GHSA-gpj5-g38j-94v9](https://github.com/advisories/GHSA-gpj5-g38j-94v9)）。

严格说本项目打不中：所有标识符都是硬编码，用户输入一律走 `bind()` 参数（唯一的字符串拼接是
固定列名 / 固定赋值片段）。但这是直接依赖上的 HIGH，升上去成本很低，就顺手升了：
`0.38.4 → 0.45.4`，`typecheck` / 97 个单测 / `db:check`（19 表 239 列 44 索引一致性）全过，
并在升级后重跑了全部 61 项攻击用例，行为无变化。

> ⚠️ 1~4 都要 `pnpm run deploy` 才会到生产。

---

## 二、本地实测：61 项用例

配套脚本已经入库，随时可重跑：

```bash
pnpm dev            # 另开一个终端
pnpm sec:check      # = node scripts/security-check.mjs
```

脚本只打本机地址（非本机要 `--force`），因为**它会写测试数据**：注册一个一次性账号、
签发几张邀请码、改一次密码。跑完把库里那几条测试行删掉即可（本地库本来就是联调数据）。

覆盖范围与结果（`PASS 61 · FAIL 0`）：

| 组 | 验的是什么 | 关键证据 |
| --- | --- | --- |
| 认证 | 匿名 / 伪造 token / Cookie 属性 / 非 https 不加 Secure / host-only | 伪造 token 401；Cookie 带 HttpOnly+SameSite=Lax+Path=/，无 Domain、无 Secure |
| CSRF | 缺自定义头、伪造 Origin、正确 Origin、GET 豁免、CORS 面 | 403 / 403 / 200 / 200 / 响应里没有 `Access-Control-Allow-Origin` |
| 授权 | 10 个后台端点 × 匿名 × 普通玩家 | 匿名 401、玩家 403，无一例外 |
| 输入 | 超长字段、1MB body、非 JSON、非法 id、limit 越界、sort 注入 | 全部 400/404，没有 500，没有栈外泄 |
| 注入 | SQL 注入串写进简介；`__proto__` 原型污染；XSS 载荷 | 表还在；role 仍是 PLAYER；XSS 原样存储（由前端转义） |
| 越权 | body 里塞 `role: ADMIN`、给报名接口塞别人的 userId、rankTier 越界 | 角色不变、未把他人登记进去、越界 400 |
| 注册 | 无效/缺失/复用邀请码、弱口令、重复用户名 | 403 / 400 / 403 / 400 / 409 |
| 会话 | 改密码后本机仍有效、其他设备被踢、退出后 token 立即失效 | 200 / 401 / 401 |
| 管理员 | 不能改自己的角色（409）；成员列表可读 | 符合预期 |
| 审计 | 授予管理员后审计日志立即出现，带 operator 与 requestId | 命中 |
| 隐私 | 玩家可见接口是否漏 password_hash / ip_hash / 邮箱 / QQ 号 | 干净；管理员视图可见 QQ 号（设计如此） |
| 头部 | CSP / XFO / nosniff / assets 长缓存 / x-request-id | 齐全 |
| 杂项 | Steam 未登录 401、state 不符时安全回跳、错误方法不 500 | 302 回 `/me?steam=error&reason=state` |

> 说明：脚本第一版有 4 条断言是我自己写错的（把 `INVITE_INVALID` 的 403 当成 400、
> 用 `data.logs` 去取实际叫 `data.entries` 的字段、拿不存在的邮箱测重复注册），
> 核对后是**测试写错不是应用有问题**。这些断言已按真实契约修正并写死，以后接口契约变了它会替你报警。

---

## 三、已有控制的实现与证据

| 控制 | 实现 | 证据 |
| --- | --- | --- |
| CSRF | `SameSite=Lax` + 自定义头 `x-hive-csrf: 1` + Origin 白名单 | 缺头 403、伪造 Origin 403 |
| 会话 | 32 字节随机 token，库里只存 `sha256(token)`；HttpOnly / Path=/ / SameSite=Lax；72h 空闲 + 14 天绝对过期 | 带 Cookie 200、不带 401、退出即失效 |
| 改密码 | `db.batch()` 原子换哈希 + 撤销其他设备会话 | 其他设备立刻 401 |
| 登录锁定 | 5 次失败锁 15 分钟；错误信息不区分"账号不存在"与"密码错" | 第 6 次 429；锁定期间正确密码也被拒 |
| 权限 | 所有 `/api/admin/*` 服务端 `requireAdmin(c)` | 6+ 端点全 403/401 |
| SQL 注入 | 全 `prepare(...).bind(...)` | 注入串写库无副作用 |
| 密码存储 | PBKDF2-HMAC-SHA256 50k + HMAC(pepper)；常数时间比较；迭代变更静默 rehash | 9 个单测 |
| 邀请码 | `crypto.getRandomValues` + 32 字符表 8 位 ≈ 40 bit；守卫式 `UPDATE` 原子扣减 | 一次性码不可复用 |
| Steam OpenID | state Cookie（HMAC 签名）+ `op_endpoint`/`return_to`/`claimed_id` + 反向 `check_authentication` | 生产跑通一次真实绑定 |
| XSS | 无 `v-html`/`innerHTML`/`eval` + CSP `script-src 'self'` | grep 零命中 |
| 密钥卫生 | 仓库无硬编码密钥；`.dev.vars`、`backups/` 已 gitignore；**git 全历史扫描**未见生产 pepper | `git log -S` 零命中 |
| IP 隐私 | 不落原始 IP，只存 `sha256(ip + salt + 日期)` | 代码审查 |

---

## 四、还没解决的风险

### P1 · 上线前应该处理

1. **`workers_dev: true` 造成双入口**
   生产同时存在 `hive.<account>.workers.dev` 与将来的自定义域名。拿到域名后改回 `false`
   并解开 `routes`，否则等于留了一个绕过"域名锁定"假设的旁路。
2. **没有自动备份**
   只有手动 `pnpm db:backup`。D1 控制台的 Time Travel 能按时间点回滚（保留期以当时套餐为准），
   但那是"补救"不是"备份"。建议每周固定导一次。
3. **本批修复尚未部署**：生产跑的还是旧构建（无 `_headers`、硬编码 `Secure` 的 Cookie）。

### P2 · 建议近期做

4. **登录没有 IP 维度的限流**
   单账号有锁定，但没有"同一 IP 高频尝试"的限制，也挡不住跨账号的低速喷洒。
   免费计划可在 Cloudflare 控制台加一条 WAF 速率限制规则（`POST /api/auth/login`，按 IP），
   **不消耗 Worker CPU**，比在 Worker 里做更划算。
5. **`zod` 的 HIGH 告警（尚未关掉）**
   `GHSA-mrhx-c7xc-m3w5`：构造超大"受限集合"可撑爆内存。官方修复在 **zod 4.6.6+**，
   我们现在是 `3.25.76` —— 要修就得跨大版本。当前不可达的原因：公开端点（登录/注册）
   的 schema 都是小对象，唯一的数组入参是分队的 `moves`（`max(10)`）和 `playerIds`（`length(10)`），
   而且 Cloudflare 本身对请求体有上限。**处置建议：下次依赖刷新时一起迁 zod 4**，别为它单独折腾。
6. **会话 Cookie 建议改用 `__Host-` 前缀**
   `__Host-hive_session` 强制"Secure + Path=/ + 不带 Domain"，从浏览器层面堵掉子域种 Cookie。
   要等自定义域名、确认全站 https 之后再做（改名 = 现有会话全失效，挑没人用的时候）。

### P3 · 记录在案

7. **账号锁定可被用来 DoS**：知道用户名就能锁对方 15 分钟。15 人封闭社区可接受。
8. **登录有轻微时序差异**：账号不存在时不做 PBKDF2，比"密码错"快约 5ms，理论上可枚举用户名。
   修法是给不存在的账号也跑一次假哈希，收益很低。
9. **旧的本地开发口令进过 git 历史**（`AGENTS.md` 里那串 `Hive-0mr3zp5bf9`，已在本轮删除并轮换）。
   它只是本机联调账号的口令，不可用于生产；介意的话等仓库哪天需要重写历史时一并清掉。
10. **`staging` 环境是半成品**：`database_id: REPLACE_WITH_STAGING_D1_ID`。误执行 `--env staging`
    会**直接部署失败**（这是好事），但别当成能用。
11. **`STEAM_WEB_API_KEY` 为空**：Steam 绑定照样成功，只是拿不到昵称头像。不是安全问题。

---

## 五、生产可靠性

**配额（Workers 免费版）**：100,000 请求/日、每次请求 10ms CPU、3 条 Cron。

当前用量：15 人、每月 4–10 场。就算把每分钟的 Cron 算满（1,440 次/日）也只占 1.4%；
密码哈希实测 ~4.8ms，占 CPU 预算一半，边界数据见 `docs/SMOKE-TEST.md`。

**架构上的单点**（已知取舍，写在这里是为了别忘）：

- D1 是唯一数据源，没有读副本；区域级故障 = 全站不可用。
- 没有 Queues，异步靠**每分钟**一次 Cron 抽 `sync_jobs`，最长延迟约 1 分钟；
  任务有租约 + 退避 + `DEAD`，`/admin/jobs` 可手工重试。
- 静态资源走资源层，不消耗 Worker 调用——这也是安全头必须放 `_headers` 的原因。

**数据层健康度**：19 表 / 239 列 / 44 索引 / 8 个迁移；
`pnpm db:check` 的 17 条不变量 + SQL↔Drizzle 一致性全过；97 个单测通过；安全用例 61 项全过。

---

## 六、发版清单

```bash
pnpm typecheck && pnpm test && pnpm build && pnpm db:check   # 四条门禁
pnpm sec:check                                              # 61 项攻击用例（需 pnpm dev 在跑）
pnpm db:migrate:remote                                      # 生产库在 0008，正常输出 No migrations to apply
pnpm run deploy
```

部署后自查：

```bash
curl -I https://hive.carloswhitea1e.workers.dev/     # 应出现 content-security-policy / x-frame-options
curl -s https://hive.carloswhitea1e.workers.dev/api/health
```

控制台侧另有两件事（代码里做不了）：加登录速率限制规则；拿到域名后关掉 `workers_dev`。
