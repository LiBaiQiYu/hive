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

本地不用 secret，直接写到 `.dev.vars`：`STRATZ_API_TOKEN=<你的 token>`（这个文件已 gitignore）。
token 在 stratz.com 的账号设置里生成，有效期到期后接口会返回 401/403，报错文案会直接提示更新 token。

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
| 登录在免费版偶发 500 | PBKDF2 迭代次数超出单请求 CPU 限制。跑 `/api/dev/hash-calibration` 取实测值，把 `PASSWORD_PBKDF2_ITERATIONS` 设到「单次 ≤6ms」的最大值 |
| 部署报 Queues 相关错误 | 免费版不支持 Queues。`wrangler.jsonc` 中的 `queues` 段必须保持注释状态 |
| Cron 部署失败 | 免费版限制单个 Worker 最多 3 个 Cron。新增定时任务必须并入已有的 `scheduled` 分发，不能加第 4 条表达式 |
| 同步任务一直不动 | 检查 `* * * * *` 的 drain Cron 是否在跑，以及 `sync_jobs.available_at` 是否被退避推到了未来 |
