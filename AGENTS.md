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
已完成  注册/登录（邀请码）/ 会话 / 资料编辑 / 位置偏好 / 段位（手填 + STRATZ，无 token 时退回 OpenDota）
        密码找回（注册邮箱发信 → Worker 回信带一次性链接；另有管理员重置与脚本兜底）
        赛事（建/开报名/关报名/封盘）/ 报名（含快照）/ 退赛回归
        自动分队（126 种枚举）/ 阵容发布 / 结果录入 / 流局
        评分算法 v3（实力分 = MMR ÷ 10；出勤独立，只影响候补优先级）/ 管理员修正 + 历史
        排行榜（按评分 / 按胜场，胜场由 team_members + radiant_win 现算）
        战绩页（我的对局 + 全员胜场；胜负来自管理员赛后选的胜负方，不含 KDA）
        后台：赛事、邀请码、评分管理、拖拽换人（PATCH lineup，乐观锁）
              成员管理（授予/撤销管理员、重置密码，禁止改自己、禁止降级最后一名管理员）
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
        段位图标是**官方的勋章 + 星星 PNG 叠出来**的（`assets/ranks/medal_1..8.png` + `star_1..5.png`，
        256×256 透明图，星星画在画布顶部，同一尺寸叠放即可对齐）：`lib/rank-assets.ts` 负责映射，
        `components/RankIcon.vue` 负责渲染；段位文字用 `rankLabel()`（冠绝与 0 星都不拼星级）。
        玩家卡左上角是 Steam/STRATZ 的公开头像（40px 圆、`referrerpolicy=no-referrer`、`@error` 自隐藏），
        没有头像时整块不渲染、布局回到原名+ID 的样子。
Steam   OpenID 成功路径**已在生产实测跑通**（2026-10-31 byc1030 绑定为 VERIFIED，
        steam_id64 76561198659699463 / dota 699433735）。`STEAM_WEB_API_KEY` 生产与本地都已配置
        （本地在 `packages/api/.dev.vars`，改完**必须重启** `pnpm dev` 才注入），绑定时会带昵称头像，
        PLAYER_SYNC 也会把历史上缺的头像补回来。回调统一用 `?steam=linked|error&reason=…` 回 `/me`，
        由前端翻译成人话弹 Toast —— 失败不再静默。
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
pnpm sec:check      # 安全攻击用例 72 项（含授权矩阵/注入/越权/隐私泄露），必须先起 pnpm dev
```

交付前必过：`pnpm typecheck && pnpm test && pnpm build && pnpm db:check`，改过鉴权/接口再补一条 `pnpm sec:check`。

## 已经踩过的坑（别再踩）

| 坑 | 正确做法 |
| --- | --- |
| `wrangler dev` 会把 `wrangler.jsonc` 的 `routes` 套到本地请求上，`request.url` 变成 `hive.example.com`（fake-ip），Steam 回调直接 ERR_EMPTY_RESPONSE | **`routes` 必须保持注释**，直到有真实域名再去掉 |
| 有了真实域名后（2026-11），本地 `pnpm dev` 里 `request.url` **和 `Host` 头都会被改写成 routes 的域名**（`hive.cwa1e.top`），只有 `APP_ORIGIN`（脚本用 `--var` 注入）还是 `127.0.0.1:8787`。Steam 回调若取 `c.req.url` 的 origin 去比对 `openid.return_to`，前缀永远对不上 → 40ms 内判死，浏览器被安静送回 `/me`，用户看到的就是「点了绑定没反应」 | `/start` 与 `/callback` 的 origin **都**走 `resolveOrigin(c.env.APP_ORIGIN, c.req.url)`；失败原因用 `?steam=error&reason=…` 带回 `/me`，页面必须翻译成人话弹出来（`MePage.vue` 的 `STEAM_ERROR_TEXT`）。想复现：拿 `/start` 的 `hive_steam_state` Cookie + 假 `openid.*` 打 `/callback`，40ms 出 `return_to` = origin 错了，300ms+ 出 `not_valid` = 校验逻辑走到了 Steam |
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
| **`wrangler dev` 只把 `secrets.required` 里声明过的键从 `.dev.vars` 注入 Worker**，没声明的键被安静丢掉（启动日志的 bindings 列表里也看不到）。`STRATZ_API_TOKEN` 曾因此从来没在本地加载过 → 本地所有段位同步都退回 OpenDota，看起来像"本地 STRATZ 绑定拿不到东西" | 用 secrets 之前先看一眼启动日志：绑定的键与 `.dev.vars` 里的键对不上，就是这里。`STRATZ_API_TOKEN` 现已加进 `secrets.required`（三个 env 都加）。**排查同类问题：`env.X` 明明配了却是空，先数一数启动日志里的 list** |
| 头像/昵称只在"绑定那一刻"写一次（claim 用快照 / Steam 绑定用 Web API），之后没有任何地方刷新 → 绑定时上游抽风、或当时还没配 `STEAM_WEB_API_KEY`，这个账号就**永远**没头像 | `PLAYER_SYNC` 现在会把快照里的昵称/头像写回 `game_accounts`（`COALESCE`，只填空）；每日维护的补同步条件里也加了 `avatar_url IS NULL`，最多一天自愈 |
| 前端还在 `pnpm dev` 时执行 `pnpm build`：Vite 会先清空 `dist` 再写入，wrangler 的 assets 清单会失效，**之后所有页面（含 `/` 和静态资源）都返回 `{"code":"NOT_FOUND","message":"接口不存在"}` 的 JSON 404**，而 `/api/*` 一切正常 —— 看着像"路由挂了"，其实是资源层没重新扫描 | 在 `dist` 里增删一个文件（如 `New-Item apps/web/dist/.reload-probe` 再删掉）触发重扫，几秒后恢复；或者直接重启 `pnpm dev`。**发布前重建前端是正常的，但别在 dev 还在跑的时候以为页面坏了就改代码** |
| 只更新 `player_ratings` 的 `effective_rating` 会撞表上的 `CHECK (effective_rating = max(0, min(1000, system_rating + admin_adjustment)))`：改天梯分时系统分也会变，而 `system_rating` 还是旧值 | 任何改评分的语句都要**把 `system_rating` 与 `admin_adjustment` 一起写**（管理员设定天梯分就是这么做的）。另外 `rating_adjustments` 上有 `CHECK (old_adjustment <> new_adjustment)`，`0 → 0` 会被拒——没有真的改修正时别插这一行 |
| 本地发信到 `reset@cwa1e.top` 收不到任何回信 | Email Routing 只在线上的边缘生效，`pnpm dev` 没有收信入口。本地要验接口就手动往 `password_resets` 插一条令牌（见 `docs/DEVELOPMENT.md` §8.0），别在本地反复发信 |
| 线上发了重置申请却没收到回信 | 先看控制台：`reset@cwa1e.top` 是不是建成了 Custom address、动作是不是 **Send to Worker**、Worker 是否已部署过（带 `email()` handler 才会出现在下拉里）。再想想发件方式——**转发来的邮件或某些客户端 SPF/DKIM 不齐，`dmarc` 不是 pass**，按设计只回"没有生成重置链接"、不发链接 |

## 关键设计决策（改了会连累别处）

- **`capacity` 是目标人数**（20 = 2 场 × 10 人），不是座位数。报名期不生成比赛；封盘时按 `floor(confirmed/10)` 切场，余数进候补。人数卡在两档之间时**必须由管理员显式选** `START_PARTIAL / EXTEND / CANCEL`（`AUTO_FINALIZE_ODD=false`）。
- **实力与可靠性分开**：`system_rating = clamp(round(估计 MMR / 10), 0, 1000)`，没有段位/MMR 时给 500 中性值；出勤**不进入**实力分。`confidence = career_matches/300` 只影响不确定度与管理员修正上限，不再把分数往 500 收缩。近期表现/位置能力/英雄池都不进评分——位置属于**分队**逻辑。
- **出勤是独立的候补指标**：`player_ratings.attendance_bp`（0..10000，无记录为 NULL），只用于 `services/waitlist.ts` 的排序：**出勤率 → 实力分 → 报名时间**（无记录按 50% 中性值）。正选与分队不看它；报名、封盘转候补、候补转正、退赛后都要重排。
- **评分重算只有一处实现**：`services/rating.ts` 的 `recomputeUserRating`（`collectInput` 也在那里）。改段位、OpenDota 同步、管理员重算、**录入比赛结果**、**赛事转 COMPLETED** 全走它；`/api/me` 会返回 `breakdown`（MMR 实力项 + 出勤明细），前端评分卡直接画构成条。算法版本落后时每日维护会补算，管理员也可以立即点「重算全部」。
- **MMR 与段位的优先级**：`rank_source='SELF_REPORTED'` 时才用 MMR；`OPENDOTA`/`ADMIN_SET` 时以勋章为准（同步时会清掉 MMR）。
- **管理员改分只改输入，不改结果**：`PUT /api/admin/ratings/players/:id/declared-mmr` 接收**目标天梯分**，写入 `declared_mmr` + `rank_tier`（`rankTierFromMmr`），评分按 MMR ÷ 10 自动重算；同时清零 `admin_adjustment`，让最终分正好等于目标值。同步来源（STRATZ / OPENDOTA）拒绝这条路（下次同步会覆盖），需先解绑。旧的手填 20000 分 → WARROOM 1000 的坑就是这么堵的。
- **密码找回走"收信 → 回信"**：免费版不能主动向任意邮箱发信，所以让玩家用注册邮箱发一封空白邮件到 `reset@cwa1e.top`；Worker 的 `email()` 校验「发件地址 == users.email + DMARC pass + 每小时 ≤3 次」后，用 `message.reply()` 回一封带一次性令牌的链接。令牌只存 `sha256`、30 分钟、一次性，重置成功作废该账号全部会话。**控制台还要把 `reset@cwa1e.top` 建为 Custom address 并指到 Worker**，代码替代不了这一步。
- **快照冻结**：报名和分队各存一份快照，改评分**不得回写**任何 `*_snapshot`；已发布的阵容不会因改评分而变。
- **身份三路径**：Steam OpenID（VERIFIED，绿）> 数字 ID + OpenDota（CLAIMED，黄）> 手填（SELF_REPORTED，灰）。归属验证**只有** Steam 能给。
- 所有 `db.batch()` 是事务：分组落库、封盘、评分修正都靠它，别拆成多次单条写入。

## 数据与环境

- 生产 D1 = `hive`（`15164698-…`），本地 = `packages/database/.wrangler/state`。**两者完全独立**，本地注册的账号生产没有。
- **本地 `.dev.vars` 已与生产共用同一套 pepper/salt**（为了让 `pnpm dev:remote` 能验过线上密码哈希）。代价：换 pepper 之前注册的本地账号哈希全部失效。2026-11-02 已用当前 pepper 把所有本地联调账号（`byc1030` / `smokeuser` / `p01`–`p11`，共 13 个）的密码重算为 **`Hive-2026-local`**；这批是纯本地测试库的口令，只对本机 `packages/database/.wrangler/state` 有效。
- 重算办法（没有 `db:seed` 脚本）：读 `.dev.vars` 的 pepper，用 Node `webcrypto` 算 `pbkdf2_sha256$p1$<迭代>$<salt>$<hash>`，再 `wrangler d1 execute --local --file`。**别在生产库上这么干**。
- `pnpm dev:remote` 是**直连生产库**的本地开发：点一下就是真写线上数据，别在里面做破坏性测试。
- **生产已部署**：**`https://hive.cwa1e.top`**（自定义域名，`workers_dev: false`，`routes: [{ pattern: "hive.cwa1e.top", custom_domain: true }]`，
  `APP_ORIGIN: https://hive.cwa1e.top`）；旧的 `hive.carloswhitea1e.workers.dev` 已不再是主入口。
  本地 `pnpm dev` 用 `--var APP_ORIGIN:http://127.0.0.1:8787` 覆盖它——**别把这个覆盖删掉**，否则本地回调会被导到线上。
- 生产 secrets（`PASSWORD_PEPPER` / `IP_HASH_SALT` / `STEAM_WEB_API_KEY` / `STRATZ_API_TOKEN`）与管理员账号密码都在 `backups/`（gitignore，**不要提交**）。**换 pepper = 现有用户全部登录失效**。
- 现在库里的都是**联调数据**，调通后直接清空重来，不需要保留。
- `packages/api/wrangler.jsonc` 是部署配置；`packages/database/wrangler.d1.jsonc` 是数据库专用配置（没有 `main`/`assets`，误用 deploy 会失败）。
- 邀请码清单在 `backups/invite-codes-*.txt`（该目录已 gitignore，**不要提交**）。本地开发码：`HIVE-DEV-01`。
- 首个管理员：本地是 `smokeuser` 和 `byc1030`；生产是 `byc1030`（注册后用 SQL 提权，仓库里没有 `db:seed` 脚本）。

## 下一步优先级

1. 控制台侧（代码里做不了）：
   - 给 `POST /api/auth/login` 加一条按 IP 的速率限制规则；
   - **Email → Email Routing** 里把 `reset@cwa1e.top` 建成 Custom address，动作选 **Send to Worker** → `hive`。
     这一步没做，邮件自助找回就不生效（管理员重置仍然可用）。
2. 域名就位后的收尾：Cloudflare 开「Always Use HTTPS」，再决定要不要给 `_headers` 补 HSTS
   （现在刻意没写，本地 http 会被钉死）。
3. Cloudflare 会自动往 HTML 注入 Web Analytics 的 `beacon.min.js`，被我们的 `script-src 'self'` 挡掉。
   二选一：控制台关掉 Web Analytics（推荐，保持零第三方脚本），或放开 `script-src`/`connect-src`。
4. 可选体验项：阵容页独立入口、公开档案页的分享卡、赛事详情页移动端布局。
5. 数据清理：联调数据确认无用后清空重来（生产导出在 `backups/`）。
