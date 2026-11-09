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
        密码找回（注册邮箱发信 → Worker 回信带一次性链接；另有管理员重置与脚本兜底；未确认邮箱的账号登录后顶部常驻提醒）
        赛事（建/开报名/关报名/封盘）/ 报名（含快照）/ 退赛回归 / **到点自动截止 → 分队 → 发布**
        自动分队（126 种枚举）/ 阵容发布 / 结果录入 / 流局
        评分算法 v3（实力分 = MMR ÷ 10；出勤独立，只影响候补优先级）/ 管理员设定（天梯分或段位 + 星级）+ 修正 + 历史
        排行榜（按评分 / 按胜场，胜场由 team_members + radiant_win 现算）
        战绩页（我的对局 + 全员胜场；胜负来自管理员赛后选的胜负方，不含 KDA）
        后台：赛事、邀请码、评分管理、拖拽换人（PATCH lineup，乐观锁）
              **阵容换人（替补 / 临时参赛）**：每个位置一个「换人」，可从本赛事没上场的报名者里挑，
              也可以让没报名的人临时参赛（只填名字，可选天梯分）；发布后仍可操作，写 `match_substitutions`
              流水与 `match.substitute` 审计。临时参赛者 `team_members.user_id` 为 NULL、只有 `guest_name/guest_mmr`，
              不进排行榜/战绩（没有账号）
              **弃赛**：换人时勾「本人没来」记 `reason=ABSENT`，那场结束后计入弃赛；
              排行榜、战绩页、个人主页都显示次数与明细，不计胜负、出勤率按未出场算
              **阵容页（`/matches/:id`）也会列出「未进阵容」的人**：候补（带顺位）、未入选、弃赛、临场换下、退赛，
              并逐条解释原因。归因在 `services/bench.ts`（纯函数 + 单测）。两条边界：
              只收**本场**被换下的人（另一场的人不算候补）；但"正选却没在任何一场里"要收进来
              （12 人报名只开一场、容量写着两场时，剩下 2 人状态仍是 CONFIRMED，不是 WAITLIST）
              成员管理（授予/撤销管理员、重置密码，禁止改自己、禁止降级最后一名管理员）
              队列健康（`/admin/jobs`，DEAD 可重试）、审计日志（`/admin/audit`，只读可筛）
              概览仪表盘（成员/赛事/本月报名/待发布/任务积压）
              开赛提醒邮件：赛事页手动发，`TEST` 只发管理员自己（验通道）、`ALL` 遍历确认名单
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
        卡片材质 8 种，其中「无限镜」（`lib/infinity.ts`）是**创始人专属**：真三维光廊
        （层间铺内壁、近层挡远层），相机角度严格跟卡片的 CSS 倾斜一致（±13°/±11°），
        越深越暗越模糊（canvas 逐帧重绘 + 三段离屏模糊）。细节见 docs/UI.md §10。
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
pnpm sec:check      # 安全攻击用例 74 项（含授权矩阵/注入/越权/隐私泄露），必须先起 pnpm dev
pnpm web:check      # Vue 模板体检：用 @vue/compiler-sfc 编一遍 .vue，抓语法错与未定义绑定
```

交付前必过：`pnpm typecheck && pnpm test && pnpm build && pnpm db:check`（改过 `.vue` 再补 `pnpm web:check`），改过鉴权/接口再补一条 `pnpm sec:check`。

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
| 老账号"没有邮箱"（`@hive.local` / `@hive.test` 这类占位地址）→ 邮件找回必然收不到 | 让本人在「账号设置 → 个人资料」把邮箱改成真地址：`PATCH /api/me` 的 `email` 必须同时带 `currentPassword`（错密码 401、被占用 409），并写审计 `user.email`。生产上 `byc1030` 已改为 `625071316@qq.com`；其余占位地址用 `SELECT username, email FROM users WHERE email LIKE '%@hive.%'` 找出来逐个通知本人 |
| 登录接口 200，但页面显示仍未登录；tail 里 `/api/me` 500 且错误是 `D1_ERROR: no such column: xxx` | 生产有**未应用的迁移**，而 `pnpm run deploy` 发出去的是**整个工作区**——别的 agent 刚写的、引用新列的代码也会被一起发到线上。症状与「登录没反应」一模一样。**部署前先 `npx wrangler d1 migrations list hive --remote -c packages/database/wrangler.d1.jsonc`，有 pending 就先 `pnpm db:migrate:remote`**（破坏性迁移前先 `pnpm db:backup`） |
| 「当前密码」框被浏览器密码管理器自动填满（`autocomplete="current-password"` 就是叫它填），于是改密码/改找回邮箱这两道"证明是你本人"的检查退化成"证明浏览器记得你的密码"——任何人走到没锁屏的电脑前点一下就过 | 当前密码一律用 `apps/web/src/components/CurrentPasswordInput.vue`：初始 `readonly`（自动填充会跳过 readonly 字段），点进来或 Tab 到才解锁；`autocomplete="off"` + `data-lpignore` / `data-1p-ignore` / `data-bwignore`。别再手写 `NInput type="password"` 当当前密码框 |
| `estimateMmr(rankTier, declaredMmr)` 的入参顺序容易写反（两个都是 `number \| null`，TS 不报错） | 段位模式和分数字段写反时，评分计划里会出现"段位 45 → 系统分 5"这种数：本地实测过一次，落库后被 `recomputeUserRating` 纠正回 293，但审计/历史里留下了错的中间值。**改这条路径后一定本地跑一遍两种模式**，看 `mmr` / `system` 是否符合预期 |
| 写"系统任务"时给 `matches.created_by` 传 `null` → `D1_ERROR: NOT NULL constraint failed: matches.created_by`（Cron 自动分队踩过） | `matches.created_by` / `events.created_by` 都是 `NOT NULL` 外键。系统任务没有"人"可填，就把 `actor.id` 填成赛事创建者（`events.created_by`），`actor.role` 仍记 `SYSTEM`——审计里照样看得出是自动跑的 |
| 部署完立刻抓首页核对新代码，结果 bundle 里什么都找不到（以为没生效） | 刚发版的那几秒，边缘还在返回旧的 `index.html`（`Cache-Control: max-age=0, must-revalidate` 不等于立即刷新）。看 `curl -D -` 的 `ETag` 变没变，等 10~30 秒再取一次；确认时按 HTML 里当前的 `<script src>` 名重新下载，别用发版前记下的 chunk 名 |
| 发信接口返回 200 但 `sent: 0`，`error` 是 `E_RECIPIENT_NOT_ALLOWED: destination address is not a verified address` | 不是代码问题：免费版只放行**已验证目的地地址**。`wrangler email routing addresses create <email>` 先把确认信发出去，本人在收件箱点掉链接（`wrangler email routing addresses list` 里 `verified` 从 `pending` 变 `verified`），再调一次接口就发出去了。`send_email` 绑定已收窄成管理员那一个地址，别"顺手"放宽（放宽＝要 Workers Paid） |
| 单测里 import 了带 `cloudflare:email` 的模块 → vitest 直接报 `Cannot find module 'cloudflare:email'` | 这个模块只在 Workers 运行时存在。`services/mailer.ts` 因此把 `import('cloudflare:email')` 放在函数内部（模块顶层不碰它），并先判断 `env.EMAIL` 是否存在（`mailConfigured()`）；写新的发信代码时照抄这个结构，别在顶层静态 import |
| 有了"临时参赛"（`team_members.user_id` 可为 NULL）之后，录入赛果 / 赛事转 COMPLETED 直接 500：`D1_ERROR: NOT NULL constraint failed: player_ratings.user_id` | `recomputeEventRatings` 会把 team_members 里的 user_id 全部拿去重算，遇到 guest 的 NULL 行就炸。凡是"按 user 聚合 team_members"的查询都要显式 `AND user_id IS NOT NULL`（已修，见 `services/rating.ts`）；本次弃赛统计也照这个规矩写 |

## 关键设计决策（改了会连累别处）

- **`capacity` 是目标人数**（20 = 2 场 × 10 人），不是座位数。报名期不生成比赛；封盘时按 `floor(confirmed/10)` 切场，余数进候补。人数卡在两档之间时**必须由管理员显式选** `START_PARTIAL / EXTEND / CANCEL`（`AUTO_FINALIZE_ODD=false`）。
- **到点自动结算 = 管理员已经选了「按现有人数开局」**：每分钟 Cron 扫 `status='REGISTRATION_OPEN' AND registration_closes_at <= now`，
  一口气跑完「关闭报名 → 封盘 → 分队 → 发布」，全程记 `SYSTEM` 审计（`services/event-auto.ts`）。
  所以 `AUTO_FINALIZE_ODD=false` 只约束**手动**封盘那条路；自动路径固定走 `START_PARTIAL`
  （12 人 → 1 场 + 2 候补），**不足 10 人只关闭报名、不自动取消**（自动取消风险太大，等管理员延期或取消）。
  想改期就在截止前改时间或手动封盘。
- **邮件分两条路，别混**：
  · **收信回信**（`email.ts` + `message.reply()`）：密码找回用，免费、发件人不限；
  · **主动发信**（`services/mailer.ts` + `EMAIL` 绑定，发件人 `notify@cwa1e.top`）：
    免费版只放行**已验证目的地地址**，`wrangler.jsonc` 因此把绑定收窄成
    `destination_address: 625071316@qq.com`（管理员本人）。越界会抛
    `E_RECIPIENT_NOT_ALLOWED`——这是套餐边界，不是 bug。
  目前只有**开赛提醒**真的发信（后台手动触发，`POST /admin/events/:id/notify-starting-soon`，
  `TEST` 只发管理员自己、`ALL` 遍历确认名单里能收信的地址，上限 20 封，逐封统计失败）；
  **报名截止的 `event.finalized` 通知仍然只写审计 `event.notify` 不发信**。
  想让全体玩家收到，要么逐个把地址加进 Destination addresses（免费、上限 200、各点一次确认信），
  要么升级 Workers Paid。
- **实力与可靠性分开**：`system_rating = clamp(round(估计 MMR / 10), 0, 1000)`，没有段位/MMR 时给 500 中性值；出勤**不进入**实力分。`confidence = career_matches/300` 只影响不确定度与管理员修正上限，不再把分数往 500 收缩。近期表现/位置能力/英雄池都不进评分——位置属于**分队**逻辑。
- **出勤是独立的候补指标（口径 v3.1）**：`player_ratings.attendance_bp`（0..10000，无记录为 NULL），
  只用于 `services/waitlist.ts` 的排序：**出勤率 → 实力分 → 报名时间**（无记录按 50% 中性值）。
  **分母只算"被排进过阵容"的场次**（在 team_members 里、或被换人流水记着 `out_user_id`），
  不是"报名过"——12 人报名只开 10 人那场时，剩下 2 个没进阵容的是**候补，不是缺勤**；
  按报名数算会把愿意来但没位置的人记成 0% 出勤。分子是真正上过场的正选场次。
  改这条口径时记得同步 `ALGO_VERSION`（v3.1 就是因为这个升的），否则旧 `attendance_bp` 不会重算。
  正选与分队不看它。
- **评分重算只有一处实现**：`services/rating.ts` 的 `recomputeUserRating`（`collectInput` 也在那里）。改段位、OpenDota 同步、管理员重算、**录入比赛结果**、**赛事转 COMPLETED** 全走它；`/api/me` 会返回 `breakdown`（MMR 实力项 + 出勤明细），前端评分卡直接画构成条。算法版本落后时每日维护会补算，管理员也可以立即点「重算全部」。
- **MMR 与段位的优先级**：`rank_source='SELF_REPORTED'` 时才用 MMR；`OPENDOTA`/`ADMIN_SET` 时以勋章为准（同步时会清掉 MMR）。
- **管理员改分只改输入，不改结果**：`PUT /api/admin/ratings/players/:id/declared-mmr` 有两种互斥输入——
  **目标天梯分**（写 `declared_mmr` + `rank_tier`，来源 `SELF_REPORTED`，评分 = MMR ÷ 10）或
  **段位 + 星级**（只写 `rank_tier`，来源 `ADMIN_SET`，评分按勋章区间估算 MMR 再 ÷ 10）。
  两种都会清零 `admin_adjustment`，让最终分正好等于系统算出来的值。
  段位模式**必须把 `declared_mmr` 置 NULL**：`estimateMmr(rankTier, declaredMmr)` 里 MMR 优先，
  留着旧分数就等于没改段位。同步来源（STRATZ / OPENDOTA）拒绝这条路（下次同步会覆盖），需先解绑。
  旧的手填 20000 分 → WARROOM 1000 的坑就是这么堵的。
- **密码找回走"收信 → 回信"**：免费版不能主动向任意邮箱发信，所以让玩家用注册邮箱发一封空白邮件到 `reset@cwa1e.top`；Worker 的 `email()` 校验「发件地址 == users.email + DMARC pass + 每小时 ≤3 次」后，用 `message.reply()` 回一封带一次性令牌的链接。令牌只存 `sha256`、30 分钟、一次性，重置成功作废该账号全部会话。**控制台还要把 `reset@cwa1e.top` 建为 Custom address 并指到 Worker**，代码替代不了这一步。
- **`email_confirmed_at` 只是提示状态**：不参与鉴权，也不代表地址真的可达（我们没有发确认信的能力）。它只决定顶部提醒条是否出现（`components/EmailReminder.vue`），换邮箱会清空要求重新确认。别拿它当"已验证邮箱"用。
- **快照冻结**：报名和分队各存一份快照，改评分**不得回写**任何 `*_snapshot`；已发布的阵容不会因改评分而变。
- **换人只补阵容、不改历史**：`match_substitutions` 记流水（换下谁、换上谁、哪个位置、操作人），
  阵容最终以 `team_members` 为准。临时参赛者 `user_id IS NULL`、只有 `guest_name/guest_mmr`，
  所有按 user 聚合的统计（排行榜、战绩、评分重算）天然跳过他们；替补用当时评分做快照，换完重算队伍总分与分差，
  但不回溯改报名快照。已 `PUBLISHED` 的比赛允许换人（比赛开始前才有人说来不了），`COMPLETED` / `VOID` 不允许。
- **弃赛只认一种事实**：`match_substitutions.reason = 'ABSENT'` 且那场比赛已 `COMPLETED`。
  换人时 team_members 里那一行已经被删掉，所以出勤率的"实际出场"天然不含他——
  统计（`services/attendance.ts`）只是把这批事实数出来给排行榜/战绩/个人主页看，
  **不另存计数**，避免出现"计数说弃赛 3 次、出勤率却是 100%"的漂移。
  `MANUAL`（纯临场调整）不算弃赛；后台换人对话框里「本人没来」默认勾选，取消勾选即记 MANUAL。
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
   - **邮件通道目前只开了「管理员一个地址」**：`EMAIL` 绑定收窄到 `625071316@qq.com`（已验证目的地），
     发件人是 `notify@cwa1e.top`（域名已在 Email Sending 开通）。
     想让全体玩家收到开赛提醒，得把每个人的邮箱加进 Destination addresses（免费、上限 200、各点一次确认信），
     或升级 Workers Paid。报名截止的 `event.finalized` 通知还没接发信（`services/notify.ts` 里留了 TODO）。
2. 域名就位后的收尾：Cloudflare 开「Always Use HTTPS」，再决定要不要给 `_headers` 补 HSTS
   （现在刻意没写，本地 http 会被钉死）。
3. Cloudflare 会自动往 HTML 注入 Web Analytics 的 `beacon.min.js`，被我们的 `script-src 'self'` 挡掉。
   二选一：控制台关掉 Web Analytics（推荐，保持零第三方脚本），或放开 `script-src`/`connect-src`。
4. 可选体验项：阵容页独立入口、公开档案页的分享卡、赛事详情页移动端布局。
5. 数据清理：联调数据确认无用后清空重来（生产导出在 `backups/`）。
