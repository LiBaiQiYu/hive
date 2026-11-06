# HIVE · DEVELOPMENT

## 1. 前置条件

Node ≥ 20、pnpm ≥ 9、`wrangler` ≥ 4（`pnpm dlx wrangler --version` 确认）、一个 Cloudflare 账号。
本机不需要安装 PostgreSQL / Redis / Docker —— 本地开发用 wrangler 内置的 D1 模拟。

## 2. 首次初始化

```bash
pnpm install

# 1) 创建 D1（生产库 hive 已创建并迁移完成；测试库按需创建）
pnpm dlx wrangler d1 create hive
pnpm dlx wrangler d1 create hive-staging   # 建完把 ID 填进 packages/database/wrangler.d1.jsonc 的 env.staging

# 2) 本地库建表（注意：数据库命令一律用 packages/database/wrangler.d1.jsonc，
#    主配置里 assets.directory 指向前端产物，前端没构建时会让 wrangler 直接报错）
pnpm db:migrate:local

# 3) 写入首个管理员 + 一个管理员邀请码（不要用 SQL 手改线上库）
pnpm db:seed --admin-username=<你的用户名> --invite-code HIVE-OPEN-01

# 4) 起开发服务（前端 Vite + Worker 同端口代理）
pnpm dev
```

密钥只走 secret，绝不写进仓库（`PASSWORD_PEPPER` 用 `openssl rand -base64 32` 生成，**丢了等于所有用户密码失效**）：

```bash
pnpm dlx wrangler secret put IP_HASH_SALT       --config packages/api/wrangler.jsonc
pnpm dlx wrangler secret put PASSWORD_PEPPER    --config packages/api/wrangler.jsonc
pnpm dlx wrangler secret put STEAM_WEB_API_KEY  --config packages/api/wrangler.jsonc
# 段位抓取：配了就走 STRATZ（额度跟 token 走），没配自动退回 OpenDota（额度按 IP 计）
pnpm dlx wrangler secret put STRATZ_API_TOKEN   --config packages/api/wrangler.jsonc
# staging 用独立的一套，不要复用生产密钥
pnpm dlx wrangler secret put IP_HASH_SALT       --config packages/api/wrangler.jsonc --env staging
pnpm dlx wrangler secret put PASSWORD_PEPPER    --config packages/api/wrangler.jsonc --env staging
pnpm dlx wrangler secret put STEAM_WEB_API_KEY  --config packages/api/wrangler.jsonc --env staging
pnpm dlx wrangler secret put STRATZ_API_TOKEN   --config packages/api/wrangler.jsonc --env staging
```

本地不用 secret，直接写到 **`packages/api/.dev.vars`**（不是仓库根目录；该文件已 gitignore）：
`PASSWORD_PEPPER` / `IP_HASH_SALT` / `STEAM_WEB_API_KEY` / `STRATZ_API_TOKEN`。
**Cloudflare 控制台里配的 secret 只有线上 Worker 用得到**，`pnpm dev` 读的是这个文件——在线上配了 key、本地忘了填，
症状是绑定成功但拿不到昵称头像。改完 `wrangler dev` 会自动重启，不用手动重启进程。
token/key 一律按 key 名逐行 `NAME=value` 写，不要加引号、不要在行尾留注释。
`STRATZ_API_TOKEN` 在 stratz.com 的账号设置里生成，有效期到期后接口会返回 401/403，报错文案会直接提示更新 token。

## 3. 脚本契约（package.json 必须提供这些名字）

| 脚本 | 作用 |
| --- | --- |
| `pnpm dev` | `vite` + `wrangler dev --config packages/api/wrangler.jsonc` 并行 |
| `pnpm build` | 构建前端到 `apps/web/dist`，类型检查 |
| `pnpm typecheck` | `tsc --noEmit`（全 workspace） |
| `pnpm lint` | ESLint + Prettier 检查 |
| `pnpm test` | Vitest（单测 + Worker 集成测试） |
| `pnpm db:generate` | `drizzle-kit generate`（只生成，不执行） |
| `pnpm db:migrate:local` | `wrangler d1 migrations apply hive --local -c packages/database/wrangler.d1.jsonc` |
| `pnpm db:migrate:remote:staging` | 同上，加 `--remote --env staging` |
| `pnpm db:migrate:remote:production` | 同上，加 `--remote`（执行前必须先 `db:backup`） |
| `pnpm db:backup` | `wrangler d1 export hive --output backups/<ts>.sql -c packages/database/wrangler.d1.jsonc` |
| `pnpm db:check` | 跑两个 Python 校验脚本 |
| `pnpm deploy:staging` / `pnpm deploy:production` | `wrangler deploy --config packages/api/wrangler.jsonc [--env staging]` |

## 4. 数据库改动流程

1. 改 `packages/database/src/schema/*.ts`；
2. `pnpm db:generate` 产出新迁移；
3. **手工补** Drizzle 表达不了的约束（`CHECK`、部分索引的 `WHERE`、跨表不变量）；
4. `pnpm db:check` 必须双绿；
5. `pnpm db:migrate:local` → 手工回归 → `staging` → 备份 → `production`。

铁律：`packages/database/migrations/*.sql` 一旦提交就是只读的。要改就新增一个迁移文件。

## 5. 代码约定

- TypeScript `strict`，禁止 `any`（`unknown` + 收窄）；所有外部输入过 Zod。
- 路径别名：`@hive/shared`、`@hive/db`、`@hive/api`。
- 时间：存储用毫秒整数，传输用 ISO 字符串，展示用 `Asia/Shanghai`。禁止在业务代码里用本地时区做日期运算。
- 命名：函数/变量 `camelCase`，类型 `PascalCase`，DB 列 `snake_case`（Drizzle 负责映射），API 字段 `camelCase`。
- 提交信息：`feat(scope): ...` / `fix(scope): ...` / `docs: ...` / `chore: ...`。
- 单测重点（按投入产出比排序）：评分公式与收缩、分组算法（含无解退化）、快照冻结、Steam 回调的六个校验点、权限守卫。

## 6. 交给 Codex / Claude Code 时的护栏

阶段顺序见 `README.md`。开工前必须把下面这段原样放进任务描述：

1. **不许 `drizzle-kit push`、不许手写 SQL 改线上库、不许编辑已存在的迁移文件。**
2. **不许在 Vue 里实现队伍总分、评分、位置匹配等业务计算**，前端只渲染接口返回值。
3. 默认环境是 `Local`；任何 `--remote` 命令必须在任务输出中显式说明目标环境，`production` 需人工确认。
4. 新增页面/接口必须同步更新 `docs/API.md`；新增表必须同步 `docs/DATABASE.md`。
5. 不要引入 Redis、消息中间件、ORM 换型、状态管理库替换等"顺手升级"。
6. 完成任务的标准不是"跑起来了"，而是：`pnpm typecheck && pnpm lint && pnpm test && pnpm db:check` 全绿。

## 7. 常见坑

| 现象 | 原因 / 处理 |
| --- | --- |
| 本地改了表但接口报 `no such column` | 忘了 `pnpm db:migrate:local`，本地 `.wrangler/state` 是独立副本 |
| 多语句写入只成功一半 | D1 无交互事务，必须 `db.batch([...])` |
| 部署后 `/events/123` 404 | `assets.not_found_handling` 必须是 `single-page-application` |
| 静态资源更新后仍是旧版 | 产物文件名带 hash，但 `index.html` 需短缓存；检查 `assets` 目录是否为新构建 |
| Steam 绑定偶发失败 | 回调 Cookie 的 `SameSite`/`Path` 与 `realm` 不一致；或 return_to 与发起时不同（反代改写了 scheme） |
| 本地点「绑定 Steam」走完 Steam 回来**什么都没发生** | 回调里用了 `c.req.url` 的 origin，而 `wrangler dev` 会把带 `routes` 的请求 URL 与 `Host` 一起改写成自定义域名（如 `hive.cwa1e.top`）→ `openid.return_to` 前缀校验必失败。`/start` 与 `/callback` 必须都走 `resolveOrigin(c.env.APP_ORIGIN, c.req.url)`。现在失败原因会带回 `/me?steam=error&reason=…` 并弹提示，直接看 `reason`：`return_to` = origin 配错，`state` = 换了地址（`localhost` vs `127.0.0.1`，Cookie 不通用），`not_valid` = Steam 说校验过期 |
| 本地绑定后没有昵称/头像 | `STEAM_WEB_API_KEY` 只写在 Cloudflare 上，本地 `.dev.vars` 还是空的 |
| 登录在免费版偶发 500 | PBKDF2 迭代次数超出单请求 CPU 限制。跑 `/api/dev/hash-calibration` 取实测值，把 `PASSWORD_PBKDF2_ITERATIONS` 设到「单次 ≤6ms」的最大值 |
| 部署报 Queues 相关错误 | 免费版不支持 Queues。`wrangler.jsonc` 中的 `queues` 段必须保持注释状态 |
| Cron 部署失败 | 免费版限制单个 Worker 最多 3 个 Cron。新增定时任务必须并入已有的 `scheduled` 分发，不能加第 4 条表达式 |
| 同步任务一直不动 | 检查 `* * * * *` 的 drain Cron 是否在跑，以及 `sync_jobs.available_at` 是否被退避推到了未来 |
| 玩家忘记密码 | 见下方 §8。免费版不能主动发信，邮件找回走「收到信再 reply」；另有管理员重置与脚本两条兜底 |

## 8. 账号恢复（忘记密码）

密码是 PBKDF2 + pepper 的不可逆哈希，**没有"找回"**，只有"重置"。三条路径，从最省事到最兜底：

### 8.0 邮件自助（玩家自己搞定）

Workers 免费版不能向任意邮箱发信，但 **Email Routing 收信免费且不限量**，所以流程反过来：

```
玩家用注册邮箱 → 发一封空邮件到 reset@cwa1e.top
        ↓ Email Routing 交给 Worker 的 email()
Worker 校验：发件地址 == users.email、DMARC 通过、1 小时内未超 3 次
        ↓ message.reply()
玩家收到回信 → 点链接 → /reset-password?token=… → 设置新密码
```

控制台要做的两件事（代码替代不了）：

1. **Email → Email Routing**：为 `cwa1e.top` 启用（会自动加 MX 记录）；
2. **Custom address**：`reset@cwa1e.top` → 动作选 **Send to Worker** → 选 `hive`。
   Worker 必须先部署一次（带 `email()` handler）才能在这里被选到。

安全约束（实现见 `packages/api/src/email.ts` 与 `services/password-reset.ts`）：

- 只认 `Authentication-Results` 里 `mx.cloudflare.net; … dmarc=pass`，否则任何人都能伪造 From 头重置别人密码；
- 令牌 32 字节随机、库里只存 `sha256`，30 分钟过期、一次性，重新申请会作废旧令牌；
- 同一账号每小时最多 3 次；失败原因不区分，回信统一说"没有生成链接"；
- 重置成功会作废该账号全部会话，并写审计 `user.password-reset-email`。

本地开发测不了收信（Email Routing 只在线上生效）。想验证接口，可以直接插一条令牌：

```bash
# token 用 node 生成：randomBytes(32).toString('base64url')，hash = sha256(token) 的 base64url
npx wrangler d1 execute hive --local --persist-to packages/database/.wrangler/state \
  -c packages/database/wrangler.d1.jsonc --command "INSERT INTO password_resets ..."
```

### 8.1 还有管理员能登录

后台 → 成员管理 → 目标玩家行末的「重置密码」：

- 服务端生成 12 位一次性临时口令（去掉 `0/O/1/l/I` 等易混字符，满足 10 位下限）；
- 同时清空失败次数与锁定时间、**作废该玩家全部会话**（旧设备立即下线）；
- 临时口令只出现在那一次响应里，页面关掉就再也看不到，也不会写进审计日志；
- 审计只记录 `user.password-reset`（操作人 + 作废的会话数）。

把临时口令私聊转交本人，让其登录后到「账号设置」立即改掉。管理员不能重置**自己**的密码——自己的走「账号设置」，避免把自己锁在外面。

### 8.2 唯一的管理员被锁在外面

这条路径不经过界面，直接改库：

```bash
# 1) 生成 SQL（默认从 packages/api/.dev.vars 读 pepper；线上库要用线上那份）
node scripts/reset-password.mjs <username> [--password <新密码>]

# 2) 确认目标环境再执行（脚本只写 SQL，不自动跑）
pnpm dlx wrangler d1 execute hive --local  --persist-to packages/database/.wrangler/state \
  -c packages/database/wrangler.d1.jsonc --file reset-password.sql
pnpm dlx wrangler d1 execute hive --remote -c packages/database/wrangler.d1.jsonc --file reset-password.sql
```

脚本生成的哈希格式与 `packages/api/src/password.ts` 完全一致（`pbkdf2_sha256$p1$…`），执行后即可用新口令登录。**pepper 用错不会报错**，只会让所有账号统统登录失败——线上那一步务必确认 pepper 来源。
