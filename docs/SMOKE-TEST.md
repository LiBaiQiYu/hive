# HIVE · 上线前两项冒烟测试

这两项各自只要十几分钟，但都属于"错了就要返工整个模块"的类型：**D1 迁移能否在真实库上跑通**，以及**免费版的 CPU 配额够不够做密码哈希**。

前置：Node ≥ 20、`npx wrangler --version` ≥ 4、`npx wrangler login` 已完成。

> 顺序不要换：先做第一部分（非破坏性，验证地基），再做第二部分（会部署一个临时的公网 Worker）。

---

## 第一部分 · D1 迁移行为验证

要验证三件事：

1. 多语句迁移文件能否被 D1 一次性执行（我们的 SQL 一个文件几十条语句）；
2. `ALTER TABLE users ADD COLUMN invite_code_id TEXT REFERENCES ...` 能否在真实 D1 上执行成功，且外键真的被写进表定义；
3. D1 是否真的执行外键约束（文档说会，但这是全部"快照冻结/引用完整性"设计的前提，必须眼见为实）。

### 1. 建测试库

```bash
npx wrangler d1 create hive-d1-smoke
```

把返回的 `database_id` 填进 `smoke/wrangler.d1-smoke.jsonc` 的 `REPLACE_WITH_ID_FROM_WRANGLER_D1_CREATE`。

### 2. 本地先跑一遍（作为对照基准）

```bash
npx wrangler d1 migrations list  hive-d1-smoke --local  -c smoke/wrangler.d1-smoke.jsonc
npx wrangler d1 migrations apply hive-d1-smoke --local  -c smoke/wrangler.d1-smoke.jsonc
```

预期：列出 `0001_init.sql`、`0002_invite_codes_and_sync_jobs.sql` 两条，均标记为待执行，apply 后全部 `✅`。

```bash
npx wrangler d1 execute hive-d1-smoke --local -c smoke/wrangler.d1-smoke.jsonc \
  --command "SELECT count(*) AS tables FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';"
```

本地基线应为 **19**（不含 `d1_migrations` 时）。记下这个数字。

### 3. 远程跑一遍（真正的验证）

```bash
npx wrangler d1 migrations apply hive-d1-smoke --remote -c smoke/wrangler.d1-smoke.jsonc
```

**如果这一步就报错**，说明多语句或 `ALTER TABLE ... REFERENCES` 不被支持，直接跳到文末「失败怎么办」。

### 4. 三项核对

```bash
# ① 表数量应为 19
npx wrangler d1 execute hive-d1-smoke --remote -c smoke/wrangler.d1-smoke.jsonc \
  --command "SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';"

# ② users 的建表语句必须已包含 invite_code_id 与 REFERENCES
npx wrangler d1 execute hive-d1-smoke --remote -c smoke/wrangler.d1-smoke.jsonc \
  --command "SELECT sql FROM sqlite_master WHERE name='users';"

# ③ 索引数量应为 43
npx wrangler d1 execute hive-d1-smoke --remote -c smoke/wrangler.d1-smoke.jsonc \
  --command "SELECT count(*) FROM sqlite_master WHERE type='index' AND (name LIKE 'ux_%' OR name LIKE 'idx_%');"
```

判定标准：

| 检查 | 通过 | 不通过意味着 |
| --- | --- | --- |
| 表数 = 19 | ✅ | 某条 `CREATE TABLE` 被静默跳过 |
| `users.sql` 含 `invite_code_id TEXT REFERENCES invite_codes (id) ON DELETE SET NULL` | ✅ | ALTER 丢掉了外键 → 要改迁移策略 |
| 索引数 = 43 | ✅ | 部分索引没建（`WHERE` 子句可能被拒） |
| `d1_migrations` 有 2 条记录 | ✅ | 迁移记录与文件不一致 |

```bash
npx wrangler d1 execute hive-d1-smoke --remote -c smoke/wrangler.d1-smoke.jsonc \
  --command "SELECT id, name, applied_at FROM d1_migrations ORDER BY id;"
```

### 5. 外键是否真的生效（最重要的一条）

```bash
# 应成功
npx wrangler d1 execute hive-d1-smoke --remote -c smoke/wrangler.d1-smoke.jsonc \
  --command "INSERT INTO users (id, username, display_name, email, password_hash) VALUES ('u_smoke','smoke','Smoke','smoke@hive.test','x');"

# 应失败：invite_code_id 指向不存在的记录
npx wrangler d1 execute hive-d1-smoke --remote -c smoke/wrangler.d1-smoke.jsonc \
  --command "INSERT INTO users (id, username, display_name, email, password_hash, invite_code_id) VALUES ('u_bad','bad','Bad','bad@hive.test','x','nope');"

# 应失败：effective_rating 与 system+adjustment 不一致（CHECK 是否被保留）
npx wrangler d1 execute hive-d1-smoke --remote -c smoke/wrangler.d1-smoke.jsonc \
  --command "INSERT INTO player_ratings (id, user_id, system_rating, admin_adjustment, effective_rating) VALUES ('r_bad','u_smoke',500,0,900);"
```

**两条都必须报错**。若都成功，说明 D1 未执行外键与 CHECK —— 那么"不变量由数据库兜底"这个假设作废，必须改成服务层强制 + 定时校验任务，这是个显著的设计变更，先别继续往下走。

### 6. 清理

```bash
npx wrangler d1 delete hive-d1-smoke
```

---

## 第二部分 · PBKDF2 CPU 校准

要验证：在免费版 10ms/请求的配额下，`PASSWORD_PBKDF2_ITERATIONS = 25000` 是否安全（目标 ≤6ms）。

**注意**：`wrangler dev` 本地不做 CPU 限额，本地测的数字没有意义，必须部署上去测。

### 1. 部署

```bash
npx wrangler deploy -c smoke/wrangler.hash-smoke.jsonc
```

记下输出里的 `https://hive-hash-smoke.<你的子域>.workers.dev`。

### 2. 跑梯度

先预热一次（丢弃），再跑四档。Windows PowerShell 用 `curl.exe` 加引号，避免 `&` 被本地 shell 吃掉：

```bash
curl.exe -s "https://hive-hash-smoke.<子域>.workers.dev/?iterations=25000"        # 预热，丢弃
curl.exe -s "https://hive-hash-smoke.<子域>.workers.dev/?iterations=5000&rounds=5"
curl.exe -s "https://hive-hash-smoke.<子域>.workers.dev/?iterations=25000&rounds=5"
curl.exe -s "https://hive-hash-smoke.<子域>.workers.dev/?iterations=50000&rounds=5"
curl.exe -s "https://hive-hash-smoke.<子域>.workers.dev/?iterations=100000&rounds=5"
```

返回体形如：

```json
{ "iterations": 25000, "rounds": 5, "pepperMs": 0.02,
  "minMs": 3.11, "medianMs": 3.42, "maxMs": 4.87,
  "nsPerIteration": 124, "verdict": "OK: 在 6ms 预算内", "samples": [3.11, 3.28, 3.42, 3.9, 4.87] }
```

如果某一档返回 Cloudflare 的错误页（1102 / "Worker exceeded CPU time limit"），说明该档已经超配额——**这本身就是一个有效结论**，记下来。

### 3. 看权威数字

`performance.now()` 量的是墙钟时间，包含调度开销，是 CPU 的乐观上界。真正的 CPU 时间在：

**Dashboard → Workers & Pages → `hive-hash-smoke` → Metrics → CPU Time（p50 / p99）**

用 25000 那一档的数字做判断，别用 100000 的（它会拉高整体）。

### 4. 判定与决策

| p99 CPU（25000 次） | 结论 | 动作 |
| --- | --- | --- |
| ≤ 6ms | 预算充足 | 保持 25000，可考虑上调到 50k~100k 换取更强哈希 |
| 6–9ms | 余量不足 | 下调到 15000–20000，并在 `docs/ARCHITECTURE.md §5.1` 记下实测值 |
| > 9ms 或 1102 | 不可行 | 降到 10000，或直接开付费版（CPU 30s），**不要靠"偶尔超时也能用"** |

无论结果如何，把最终值写回 `packages/api/wrangler.jsonc` 两个环境的 `PASSWORD_PBKDF2_ITERATIONS`，并在 `ARCHITECTURE.md §5.1` 里更新那行"默认 25,000 次（保守起点）"为实测值——文档里留一个没被验证过的数字，比留空更危险。

### 5. 立刻删除

这个 Worker 是无鉴权的 CPU 燃烧器，留在线上等于开放一个免费算力接口：

```bash
npx wrangler delete -c smoke/wrangler.hash-smoke.jsonc
```

---

## 失败怎么办

**第一部分在多语句上失败**：把每个迁移文件拆成一条语句一个文件（`0001_001_create_users.sql` …），`wrangler` 会按文件名顺序执行。工作量大但机械，我可以生成拆分脚本。

**第一部分在 `ALTER TABLE ... ADD COLUMN ... REFERENCES` 上失败**：这是 SQLite 在 `foreign_keys=ON` 下的已知限制路径。改为"重建表法"写 `0003`：新建 `users_new`（含列与所有约束）→ `INSERT ... SELECT` → `DROP TABLE users` → `ALTER TABLE users_new RENAME TO users` → 重建全部索引，并在文件开头加 `PRAGMA defer_foreign_keys = on;`。注意这种迁移必须先在 staging 上验证，因为它会短暂锁表。

**第二部分全部超时（连 5000 次都 1102）**：说明这个账号/地区对 CPU 的计量比预期严，别恋战——直接上 Workers 付费版，$5/月换 310,000 次迭代的正确安全基线。这是这笔项目里唯一值得花的钱。

**两部分都通过**：把两份输出贴在仓库 `docs/SMOKE-TEST.md` 末尾的"实测记录"一节，作为后续回归的基准。

---

## 实测记录

### 第一部分 · D1 迁移（2026-10-30 实测通过）

环境：wrangler 4.156.0，远程 D1 `hive-d1-smoke`（`87c1e863-5b9c-4517-9e4c-07ccc228a9a2`），全新空库。

| 检查项 | 预期 | 实测 | 结论 |
| --- | --- | --- | --- |
| 多语句迁移文件 | 可执行 | `0001` 55 条语句 / 8.30ms；`0002` 10 条 / 2.56ms | ✅ 一个文件几十条语句没问题 |
| `ALTER TABLE ... ADD COLUMN ... REFERENCES` | 可执行且保留外键 | `users` 末尾已含 `invite_code_id TEXT REFERENCES invite_codes (id) ON DELETE SET NULL` | ✅ 不需要重建表法 |
| 表数量 | 19 | 19（另有 `d1_migrations`、`sqlite_sequence`、`_cf_KV` 三张系统表） | ✅ |
| 列总数 | 233 | 233，逐表核对零缺失 | ✅ |
| 索引数量 | 43 | 43 | ✅ |
| 迁移记录 | 2 条 | `0001_init.sql`、`0002_invite_codes_and_sync_jobs.sql` | ✅ |

约束执行情况（这是设计的地基）：

| 测试 | 预期 | 实测 |
| --- | --- | --- |
| 合法用户插入 | 成功 | 成功 |
| `users.invite_code_id` 指向不存在的行 | 拒绝 | **拒绝** → D1 确实执行外键 |
| `player_ratings` 的 `effective = system + adjustment` | 拒绝 | **拒绝** → CHECK 保留 |
| `users.username = lower(username)` | 拒绝 | **拒绝** |
| `events.capacity % 10 = 0` | 拒绝 | **拒绝** |
| `ux_users_qq_number`（NULL 可多条、非 NULL 不可重复） | 前者成功、后者拒绝 | 符合 |
| `ux_sync_jobs_dedupe`（`status IN ('PENDING','RUNNING')`） | 在途重复拒绝、DONE 后可再入队 | 符合 |

**结论：迁移策略与"数据库兜底不变量"的假设成立，不需要改写 0001/0002。**

### 一个需要记住的坑

远程 `sqlite_master.sql` 里，部分行内注释后的换行被规范化成了**字面量 `\n`**，例如：

```sql
-- 格式：pbkdf2_sha256$<iterations>$<salt>$<hash>，便于迭代次数升级与算法迁移\n  password_hash     TEXT    NOT NULL,
```

列本身都在（已验证 233/233），说明这是**存储文本**被改写，而非执行时被注释吞掉。但它意味着：

> **永远不要拿 `sqlite_master.sql` 的输出当作表重建的模板**（`0003` 那种"建新表→搬数据→改名"的迁移），因为它可能把列注释掉。重建表必须手写完整 DDL，或从 `packages/database/migrations/` 里复制。

### 第二部分 · PBKDF2 校准（2026-10-30 实测）

**两个测量陷阱**——这才是这轮测试真正的收获：

1. `performance.now()` 在 Workers 里被钳制，单次哈希几毫秒的变化全被抹平，服务端自计时返回全 0。**不能用它测 CPU。**
2. 客户端墙钟差同样无效：本机到边缘 RTT 约 148ms，抖动远大于 6ms 的差值。1000 次与 100000 次分别测出 148.1ms / 147.9ms，毫无区分度。

**唯一可靠的方法：二分 1102 边界。** 免费版超 CPU 会直接失败，边界就是 10ms 的真实位置，且不依赖任何计时器。

| 每请求迭代次数 | 结果 |
| --- | --- |
| 50,000 | 3/3 通过 |
| 100,000 | 3/3 通过 |
| 105,000 | 0/3，全部超限 |
| 120,000 / 200,000 | 0/3，全部超限 |

边界锐利地卡在 100k 与 105k 之间，扣除固定开销后约 **95ns/次迭代**。

| 迭代次数 | 折算 CPU | 判定 |
| --- | --- | --- |
| 25,000 | ~2.4ms | 余量 7.6ms，过于保守 |
| **50,000** | **~4.8ms** | **采用**：留 5ms 给路由、校验、响应 |
| 100,000 | ~9.5ms | 不可用，任何额外工作都会 1102 |

`PASSWORD_PBKDF2_ITERATIONS` 已由 25,000 上调到 **50,000**（强度翻倍，仍占一半预算）。

这条方法可复用：**别去测量耗时，去测量失败边界。** 对于任何"这段代码到底吃多少 CPU"的问题，二分到 1102 比任何计时器都准。
