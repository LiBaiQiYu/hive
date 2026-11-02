# HIVE · 给下一个 agent 的记忆

> 读这份文件就够了。它记录**为什么这么写**和**哪些坑已经踩过**，
> 细节再看 `docs/` 下的 ARCHITECTURE / DATABASE / API / UI / SMOKE-TEST，
> 安全与生产可靠性的体检报告在 `docs/SECURITY-AUDIT.md`（含已验证有效的控制清单和未解决风险）。

## 这是什么

DOTA2 固定社区（单 QQ 群、约 15 人、每月 4–10 场）的 5v5 内战平台。
全栈跑在 **Cloudflare Workers 免费版**：一个 Worker 同时提供 Vue SPA 和 Hono API，
数据在 D1，异步任务靠 D1 outbox + Cron（**免费版没有 Queues**）。

## 当前状态

```
已完成  注册/登录（邀请码）/ 会话 / 资料编辑 / 位置偏好 / 段位（手填 + OpenDota）
        赛事（建/开报名/关报名/封盘）/ 报名（含快照）/ 退赛回归
        自动分队（126 种枚举）/ 阵容发布 / 结果录入 / 流局
        评分算法 v3（实力分 = MMR ÷ 10；出勤独立，只影响候补优先级）/ 管理员修正 + 历史
        排行榜（按评分 / 按胜场，胜场由 team_members + radiant_win 现算）
        战绩页（我的对局 + 全员胜场；胜负来自管理员赛后选的胜负方，不含 KDA）
        后台：赛事、邀请码、评分管理、拖拽换人（PATCH lineup，乐观锁）
              成员管理（授予/撤销管理员，禁止改自己、禁止降级最后一名管理员）
              队列健康（`/admin/jobs`，DEAD 可重试）、审计日志（`/admin/audit`，只读可筛）
              概览仪表盘（成员/赛事/本月报名/待发布/任务积压）
前端    Vue 3 + vue-router + **Naive UI**（按钮/下拉/日期/输入/确认框/Toast），深/浅色双主题，玩家卡片（3D 倾斜）
        主题映射在 `apps/web/src/lib/ui.ts`（Naive 色板 → HIVE 的 --gold/--surface），后台路由按需加载
        `NConfigProvider` 挂了 `zhCN` + `dateZhCN`；日期选择器要「只到分钟」就传 `time-picker-format="HH:mm"`
        —— Naive 的时/分/秒列是按 `format` 推导的，不需要（也没有）`showSecond` 这类开关
        按钮统一用 `NButton`：默认态=描边、`type="primary"`=主行动、表格行内小动作才用 `quaternary`
        顶栏：主题切换是单图标圆按钮（日月交叉旋转），用户名是 `NDropdown`（我的主页 / 账号设置 / 后台 / 退出）
        「我的主页」`/me` 只放档案四块（评分 / 游戏身份 / 卡片外观 / 位置偏好），组件在 `components/me/`；
        资料与密码在「账号设置」`/settings`，只从下拉进入，带登录守卫（未登录跳 `/login?redirect=`）
Steam   OpenID 成功路径**已在生产实测跑通**（2026-10-31 byc1030 绑定为 VERIFIED，
        steam_id64 76561198659699463 / dota 699433735）；填上 STEAM_WEB_API_KEY 才有昵称头像
未做    OpenDota 对局导入（**明确不做**：用户决定"赛后手工选胜负方"就够了，KDA 不展示）
        赛事详情页的场次列表已能跳到 `/matches/:id` 看公开阵容；阵容页本身没有独立导航入口
```

## 跑起来

```bash
pnpm install
pnpm build          # 必须先构建前端，否则 wrangler 因 assets.directory 不存在而报错
pnpm dev            # http://127.0.0.1:8787，连本地 D1
pnpm dev:remote     # 同上端口，但 Worker 跑在 Cloudflare 边缘、直连生产 D1（要先 wrangler login）
pnpm dev:web        # 可选，Vite 热更新（5173，已配 /api 代理）
pnpm run deploy     # 部署到 Cloudflare（必须带 run：直接 `pnpm deploy` 会命中 pnpm 自带的 deploy 命令）
pnpm sec:check      # 安全攻击用例 61 项（含授权矩阵/注入/越权/隐私泄露），必须先起 pnpm dev
```

交付前必过：`pnpm typecheck && pnpm test && pnpm build && pnpm db:check`，改过鉴权/接口再补一条 `pnpm sec:check`。

## 已经踩过的坑（别再踩）

| 坑 | 正确做法 |
| --- | --- |
| `wrangler dev` 会把 `wrangler.jsonc` 的 `routes` 套到本地请求上，`request.url` 变成 `hive.example.com`（fake-ip），Steam 回调直接 ERR_EMPTY_RESPONSE | **`routes` 必须保持注释**，直到有真实域名再去掉 |
| 本地 D1 状态按**配置文件目录**解析，`wrangler d1` 与 `wrangler dev` 会各用一份 | 一律带 `--persist-to packages/database/.wrangler/state`（已写进脚本） |
| 用 PowerShell 的 `-replace`/`Set-Content` 改含中文的源码 → 按 GBK 解码，整文件乱码且不可逆 | **只能用 edit 工具改源码**。2026-10-31 又踩了一次：只是"读出来改 4 行再写回"，`Get-Content`(ANSI) + `Set-Content -Encoding UTF8` 就把整页中文变成 `淇濆瓨` 这类乱码，靠 `git checkout` 才救回来 |
| `$pid` / `$host` / `$error` 是 PowerShell 只读变量，赋值静默失败 | 换名字（如 `$uid`） |
| Vue `v-model.number` 留空时给的是 `''` 不是 `null`，`??` 拦不住 | 提交前显式转换成 `null` |
| `select` 的原生下拉由系统绘制，`background` 简写会把箭头（background-image）清掉 | `.input` 只用 `background-color` |
| D1 迁移里 `ALTER TABLE ADD COLUMN ... REFERENCES` 可用；重建表必须手写 DDL，**不要复制 `sqlite_master.sql`**（D1 会把注释里的换行存成字面量 `\n`） | 见 `0003` 的写法 |
| `.btn:hover:not(:disabled)` 权重高于 `.btn-primary` | 主按钮要在 hover/active 都钉死 `color` |
| Workers 的 `performance.now()` 被钳制，测不了 CPU | 用**二分 1102 边界**测（见 SMOKE-TEST.md） |
| `wrangler dev --remote` 下 Worker 在边缘执行，`request.url` 是**生产域名**，浏览器发来的 Origin 却是 `http://127.0.0.1:8787` → CSRF 来源校验把登录挡成 403 | CSRF 的白名单同时接受 `APP_ORIGIN`（remote 模式下用 `--var APP_ORIGIN:http://127.0.0.1:8787`），见 `app.ts` |
| 换了 `PASSWORD_PEPPER` 后，旧哈希全部验不过（本地库尤其容易踩） | 本地 `.dev.vars` 的 pepper 必须与要连的那个库一致；跨库复用账号 = 共用同一套 pepper + 同一批用户行 |
| **拉下别人提交的新迁移后忘了迁移本地库** → 登录 200 但 `/api/me` 500（`D1_ERROR: no such column: card_material`），前端表现成"登录没反应、还是没登录" | `pnpm dev` / `dev:api` 现在会先跑 `db:migrate:local`（幂等）；`dev:remote` 不管迁移，切机器后先手动 `pnpm db:migrate:local`。判断是迁移落后还是真 bug，直接看 wrangler dev 的 stderr 里的 `D1_ERROR` |
| 会话 Cookie 写死 `Secure`，用非 https 的地址（局域网 IP、非 localhost 主机名）开发时浏览器直接丢弃 Cookie | `secure` 由 `cookieSecure(env, c.req.url)` 推出：看 `APP_ORIGIN` 的 scheme，https 才加 `Secure`（`packages/api/src/env.ts`） |
| `run_worker_first: ["/api/*"]` 意味着**静态资源根本不进 Worker**，Hono 的 `secureHeaders()` 对页面一行都不生效——HTML/JS/CSS 长期没有 CSP、没有防点击劫持 | 资源层约定文件 `apps/web/public/_headers`（构建时拷进 `dist/`，边缘加头、不耗 Worker 调用）。改完重建 + 发版才生效 |

## 关键设计决策（改了会连累别处）

- **`capacity` 是目标人数**（20 = 2 场 × 10 人），不是座位数。报名期不生成比赛；封盘时按 `floor(confirmed/10)` 切场，余数进候补。人数卡在两档之间时**必须由管理员显式选** `START_PARTIAL / EXTEND / CANCEL`（`AUTO_FINALIZE_ODD=false`）。
- **实力与可靠性分开**：`system_rating = clamp(round(估计 MMR / 10), 0, 1000)`，没有段位/MMR 时给 500 中性值；出勤**不进入**实力分。`confidence = career_matches/300` 只影响不确定度与管理员修正上限，不再把分数往 500 收缩。近期表现/位置能力/英雄池都不进评分——位置属于**分队**逻辑。
- **出勤是独立的候补指标**：`player_ratings.attendance_bp`（0..10000，无记录为 NULL），只用于 `services/waitlist.ts` 的排序：**出勤率 → 实力分 → 报名时间**（无记录按 50% 中性值）。正选与分队不看它；报名、封盘转候补、候补转正、退赛后都要重排。
- **评分重算只有一处实现**：`services/rating.ts` 的 `recomputeUserRating`（`collectInput` 也在那里）。改段位、OpenDota 同步、管理员重算、**录入比赛结果**、**赛事转 COMPLETED** 全走它；`/api/me` 会返回 `breakdown`（MMR 实力项 + 出勤明细），前端评分卡直接画构成条。算法版本落后时每日维护会补算，管理员也可以立即点「重算全部」。
- **MMR 与段位的优先级**：`rank_source='SELF_REPORTED'` 时才用 MMR；`OPENDOTA`/`ADMIN_SET` 时以勋章为准（同步时会清掉 MMR）。
- **快照冻结**：报名和分队各存一份快照，改评分**不得回写**任何 `*_snapshot`；已发布的阵容不会因改评分而变。
- **身份三路径**：Steam OpenID（VERIFIED，绿）> 数字 ID + OpenDota（CLAIMED，黄）> 手填（SELF_REPORTED，灰）。归属验证**只有** Steam 能给。
- 所有 `db.batch()` 是事务：分组落库、封盘、评分修正都靠它，别拆成多次单条写入。

## 数据与环境

- 生产 D1 = `hive`（`15164698-…`），本地 = `packages/database/.wrangler/state`。**两者完全独立**，本地注册的账号生产没有。
- **本地 `.dev.vars` 已与生产共用同一套 pepper/salt**（为了让 `pnpm dev:remote` 能验过线上密码哈希）。代价：换 pepper 之前注册的本地账号哈希全部失效。2026-11-02 已用当前 pepper 把所有本地联调账号（`byc1030` / `smokeuser` / `p01`–`p11`，共 13 个）的密码重算为 **`Hive-2026-local`**；这批是纯本地测试库的口令，只对本机 `packages/database/.wrangler/state` 有效。
- 重算办法（没有 `db:seed` 脚本）：读 `.dev.vars` 的 pepper，用 Node `webcrypto` 算 `pbkdf2_sha256$p1$<迭代>$<salt>$<hash>`，再 `wrangler d1 execute --local --file`。**别在生产库上这么干**。
- `pnpm dev:remote` 是**直连生产库**的本地开发：点一下就是真写线上数据，别在里面做破坏性测试。
- **生产已部署**：`https://hive.carloswhitea1e.workers.dev`（Cloudflare 账号 `carloswhitea1e@gmail.com`，Worker 名 `hive`）。还没有自定义域名，所以 `workers_dev` 暂时为 `true`；`routes` 仍保持注释，拿到域名后两者一起改。
- 生产 secrets（`PASSWORD_PEPPER` / `IP_HASH_SALT` / 空 `STEAM_WEB_API_KEY`）与管理员账号密码都在 `backups/`（gitignore，**不要提交**）。**换 pepper = 现有用户全部登录失效**。
- 现在库里的都是**联调数据**，调通后直接清空重来，不需要保留。
- `packages/api/wrangler.jsonc` 是部署配置；`packages/database/wrangler.d1.jsonc` 是数据库专用配置（没有 `main`/`assets`，误用 deploy 会失败）。
- 邀请码清单在 `backups/invite-codes-*.txt`（该目录已 gitignore，**不要提交**）。本地开发码：`HIVE-DEV-01`。
- 首个管理员：本地是 `smokeuser` 和 `byc1030`；生产是 `byc1030`（注册后用 SQL 提权，仓库里没有 `db:seed` 脚本）。

## 下一步优先级

1. 填 `STEAM_WEB_API_KEY`（拿 Steam 昵称/头像）+ 自定义域名（解开 `routes`、`workers_dev` 改回 false）。
2. 线上部署这批改动（job runner / 拖拽换人 / 排行榜 / 战绩页 / 后台四件套 / 公开阵容页 /
   会话 Cookie 的 `Secure` 推导 / `_headers` 安全头 / 每日维护的审计裁剪）。
3. 可选：给阵容页加独立入口（目前只能从赛事详情的场次列表点进去）。
4. 控制台侧的两件事（代码里做不了）：给 `POST /api/auth/login` 加一条按 IP 的速率限制规则；
   域名就位后关掉 `workers_dev`。
