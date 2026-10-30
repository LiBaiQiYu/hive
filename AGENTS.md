# HIVE · 给下一个 agent 的记忆

> 读这份文件就够了。它记录**为什么这么写**和**哪些坑已经踩过**，
> 细节再看 `docs/` 下的 ARCHITECTURE / DATABASE / API / UI / SMOKE-TEST。

## 这是什么

DOTA2 固定社区（单 QQ 群、约 15 人、每月 4–10 场）的 5v5 内战平台。
全栈跑在 **Cloudflare Workers 免费版**：一个 Worker 同时提供 Vue SPA 和 Hono API，
数据在 D1，异步任务靠 D1 outbox + Cron（**免费版没有 Queues**）。

## 当前状态

```
已完成  注册/登录（邀请码）/ 会话 / 资料编辑 / 位置偏好 / 段位（手填 + OpenDota）
        赛事（建/开报名/关报名/封盘）/ 报名（含快照）/ 退赛回归
        自动分队（126 种枚举）/ 阵容发布 / 结果录入 / 流局
        评分算法 v2（段位 900 + 出勤 100）/ 管理员修正 + 历史
        后台：赛事、邀请码、评分管理
前端    Vue 3 + vue-router，深/浅色双主题，玩家卡片（3D 倾斜）
未做    Steam OpenID 已实现但**成功路径未端到端验证**（需真人登录 Steam）
        OpenDota 同步的 job runner（sync_jobs 只会堆积，没有消费者）
        拖拽换人（只能换 seed 重新生成）
        排行榜页、战绩页（导航里是灰的）
```

## 跑起来

```bash
pnpm install
pnpm build          # 必须先构建前端，否则 wrangler 因 assets.directory 不存在而报错
pnpm dev            # http://127.0.0.1:8787
pnpm dev:web        # 可选，Vite 热更新（5173，已配 /api 代理）
```

交付前四条必过：`pnpm typecheck && pnpm test && pnpm build && pnpm db:check`

## 已经踩过的坑（别再踩）

| 坑 | 正确做法 |
| --- | --- |
| `wrangler dev` 会把 `wrangler.jsonc` 的 `routes` 套到本地请求上，`request.url` 变成 `hive.example.com`（fake-ip），Steam 回调直接 ERR_EMPTY_RESPONSE | **`routes` 必须保持注释**，直到有真实域名再去掉 |
| 本地 D1 状态按**配置文件目录**解析，`wrangler d1` 与 `wrangler dev` 会各用一份 | 一律带 `--persist-to packages/database/.wrangler/state`（已写进脚本） |
| 用 PowerShell 的 `-replace`/`Set-Content` 改含中文的源码 → 按 GBK 解码，整文件乱码且不可逆 | **只能用 edit 工具改源码** |
| `$pid` / `$host` / `$error` 是 PowerShell 只读变量，赋值静默失败 | 换名字（如 `$uid`） |
| Vue `v-model.number` 留空时给的是 `''` 不是 `null`，`??` 拦不住 | 提交前显式转换成 `null` |
| `select` 的原生下拉由系统绘制，`background` 简写会把箭头（background-image）清掉 | `.input` 只用 `background-color` |
| D1 迁移里 `ALTER TABLE ADD COLUMN ... REFERENCES` 可用；重建表必须手写 DDL，**不要复制 `sqlite_master.sql`**（D1 会把注释里的换行存成字面量 `\n`） | 见 `0003` 的写法 |
| `.btn:hover:not(:disabled)` 权重高于 `.btn-primary` | 主按钮要在 hover/active 都钉死 `color` |
| Workers 的 `performance.now()` 被钳制，测不了 CPU | 用**二分 1102 边界**测（见 SMOKE-TEST.md） |

## 关键设计决策（改了会连累别处）

- **`capacity` 是目标人数**（20 = 2 场 × 10 人），不是座位数。报名期不生成比赛；封盘时按 `floor(confirmed/10)` 切场，余数进候补。人数卡在两档之间时**必须由管理员显式选** `START_PARTIAL / EXTEND / CANCEL`（`AUTO_FINALIZE_ODD=false`）。
- **评分只算两项**：段位 900 + 出勤 100，`confidence = career_matches/300`，收缩下限 0.8。近期表现/位置能力/英雄池都不进评分——位置属于**分队**逻辑，战绩/英雄池等接 OpenDota 后做展示。
- **MMR 与段位的优先级**：`rank_source='SELF_REPORTED'` 时才用 MMR；`OPENDOTA`/`ADMIN_SET` 时以勋章为准（同步时会清掉 MMR）。
- **快照冻结**：报名和分队各存一份快照，改评分**不得回写**任何 `*_snapshot`；已发布的阵容不会因改评分而变。
- **身份三路径**：Steam OpenID（VERIFIED，绿）> 数字 ID + OpenDota（CLAIMED，黄）> 手填（SELF_REPORTED，灰）。归属验证**只有** Steam 能给。
- 所有 `db.batch()` 是事务：分组落库、封盘、评分修正都靠它，别拆成多次单条写入。

## 数据与环境

- 生产 D1 = `hive`（`15164698-…`），本地 = `packages/database/.wrangler/state`。**两者完全独立**，本地注册的账号生产没有。
- `packages/api/wrangler.jsonc` 是部署配置；`packages/database/wrangler.d1.jsonc` 是数据库专用配置（没有 `main`/`assets`，误用 deploy 会失败）。
- 邀请码清单在 `backups/invite-codes-*.txt`（该目录已 gitignore，**不要提交**）。本地开发码：`HIVE-DEV-01`。
- 首个管理员：本地是 `smokeuser` 和 `byc1030`；生产库需要重新注册再提权。

## 下一步优先级

1. **job runner**（`sync_jobs` 的 drain + Cron 分发）——现在 `RATING_RECOMPUTE` 任务只进不出。
2. **Steam 绑定成功路径的真人验证**（本地 `http://127.0.0.1:8787`，不要用域名）。
3. 拖拽换人（接口契约已是"整份 moves 提交"，只需补 UI）。
4. 排行榜 / 战绩页（`GET /api/leaderboard`、`/api/me/matches` 尚未实现）。
