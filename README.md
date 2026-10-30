# HIVE

**DOTA2 COMMUNITY WARROOM · V1.0** — 一个固定社区的 DOTA2 5v5 内战管理平台。

单个 QQ 群、约 15 人、仅 DOTA2 5v5、系统自动分队 + 管理员拖拽调整。
前端与后端全部部署在 Cloudflare 生态内：**一个 Worker、一个域名、一个 D1 数据库**。

```
Vue 3 + TypeScript + Vite   →  Workers Static Assets
Hono + TypeScript           →  Cloudflare Worker (/api/*)
Drizzle ORM + SQLite        →  Cloudflare D1
Cron Triggers + D1 outbox  →  Steam / OpenDota 同步、评分重算（免费版无 Queues）
```

运行基线：**Workers 免费版**（每请求 CPU 10ms、Cron ≤3 个、无 Queues），注册采用**邀请码制**。
实际规模：**15 人左右、每月 4～10 场**——基础设施远未触顶，真正的瓶颈是管理员的操作次数和"凑够 10 个人"。

## 当前状态

本仓库目前是**工程设计基线**，尚未包含应用代码。目标是让实现阶段按既定架构推进，不中途推翻技术选型。

已完成并经过机器校验：

| 产物 | 说明 |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 决策记录、拓扑、认证（含 Steam OpenID 六项校验）、评分与分组算法、异步任务、发布流程 |
| [docs/DATABASE.md](docs/DATABASE.md) | 19 张表的设计说明、17 条核心不变量、D1 硬约束、迁移与容量规划 |
| [docs/API.md](docs/API.md) | REST 契约、错误码、并发与快照语义 |
| [docs/UI.md](docs/UI.md) | 界面设计基线：路由/页面与接口的映射、组件清单、状态映射、设计缺口 |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | 本地环境、脚本契约、AI 编码护栏 |
| [docs/SMOKE-TEST.md](docs/SMOKE-TEST.md) | 上线前两项冒烟测试：D1 迁移行为、免费版 PBKDF2 CPU 校准 |
| [packages/database/migrations/0001_init.sql](packages/database/migrations/0001_init.sql) | D1 初始 Schema（唯一真源） |
| [packages/database/src/schema/](packages/database/src/schema/index.ts) | Drizzle Schema（与 SQL 逐列对齐） |
| [packages/api/wrangler.jsonc](packages/api/wrangler.jsonc) | 单一 Worker 配置，含 staging 环境隔离 |

```bash
python packages/database/scripts/check_schema.py   # 真实 SQLite 执行全部迁移 + 17 条不变量
python packages/database/scripts/check_parity.py   # SQL ↔ Drizzle 一致性
```

## 实现顺序

| 阶段 | 任务 | 优先级 |
| --- | --- | --- |
| 1 | Monorepo、Vue、Hono、Worker 初始化 | P0 |
| 2 | D1 + Drizzle 迁移落地（本仓库已给出 DDL） | P0 |
| 3 | 注册登录（邀请码）、Steam OpenID、权限 | P0 |
| 4 | 玩家档案、Steam 数据同步 | P0 |
| 5 | 赛事创建、报名、候补 | P0 |
| 6 | WARROOM Rating、管理员修正 | P0 |
| 7 | 自动分组、位置约束 | P0 |
| 8 | 分组编辑器（拖拽）、发布 | P0 |
| 9 | 比赛结果、Match ID 导入 | P1 |
| 10 | 排行榜、历史战绩 | P1 |
| 11 | 生产部署、备份、日志、监控 | P0 |

## 明确不做

队长选人 · 多社区 · 跨游戏 · 实时语音 · 自动建房 · Redis · 微服务 · R2 · Durable Objects。
