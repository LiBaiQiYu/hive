# HIVE 自建部署：1Panel + Docker Compose + GitHub Actions

这份文档描述如何把 HIVE 从 Cloudflare Workers 迁到自己的服务器，并用
GitHub Actions 实现 `push main` 即自动部署。

**核心取舍：构建在云端完成，服务器只负责运行。** 前端 `vite build` 和后端
`esbuild` 都在 GitHub 的 4 核 16G 机器上跑完，只把 10 MB 左右的产物传过去——
2 核 2G 的服务器全程不承担构建内存峰值。

## 架构

```
本地 push main
      │
      ▼
GitHub Actions (ubuntu-latest)
  ├ pnpm install --frozen-lockfile
  ├ pnpm typecheck + pnpm test
  ├ pnpm build          → apps/web/dist
  ├ pnpm build:server   → packages/api/dist/{server,migrate}.mjs
  ├ 组装 hive.tar.gz（server.mjs + migrate.mjs + public/ + migrations/）
  └ scp 到服务器 + ssh 执行 remote-deploy.sh
      │
      ▼
服务器 /opt/hive/
  ├ releases/20261124-173000/   解包后的构建上下文
  ├ current -> releases/...     符号链接，切换即"发布"
  ├ shared/.env                 运行期密钥，权限 600
  ├ shared/data/hive.db         SQLite（唯一需要备份的东西）
  ├ Dockerfile                  镜像定义
  ├ docker-compose.yml
  └ remote-deploy.sh
      │
      ▼
Docker 容器 node:22-bookworm-slim，跑 node server.mjs，监听 127.0.0.1:8787
      │
      ▼
1Panel 网站（反向代理）→ 域名 + HTTPS + gzip → 用户
```

代码是**打进镜像**的（`build: ./current`），不是 bind mount。
这样切版本天然生效，也不用处理"符号链接换了但容器还挂着旧目录"那个坑。
`remote-deploy.sh` 每次会把最新的 `Dockerfile` 复制进 release 目录——
它必须是构建上下文的一部分，否则 `docker build` 看不到它。

---

## 一、服务器初始化（只做一次）

### 1. 准备目录与文件

```bash
# 在服务器上
sudo mkdir -p /opt/hive/{releases,shared/data}
sudo chmod 750 /opt/hive/shared
```

从本地传两个文件过去（其余文件 CI 每次会自动更新）：

```bash
scp deploy/docker-compose.yml root@<server>:/opt/hive/
scp deploy/Dockerfile         root@<server>:/opt/hive/
scp deploy/bootstrap-server.sh root@<server>:/tmp/
ssh root@<server> 'bash /tmp/bootstrap-server.sh'
```

`bootstrap-server.sh` 会生成 `shared/.env` 模板（权限 600）并建好 `shared/data`。

### 2. 配置运行期环境变量

```bash
ssh root@<server>
vi /opt/hive/shared/.env
chmod 600 /opt/hive/shared/.env
```

模板见 `deploy/.env.example`。**必填三项**：

| 变量 | 说明 |
| --- | --- |
| `APP_ORIGIN` | 对外地址，含协议，不要结尾斜杠。决定 Steam 回调的 realm 与 Cookie 的 Secure |
| `PASSWORD_PEPPER` | 密码哈希的 pepper。**必须与线上 Workers 用的完全一致**，否则现有用户全部登录失效 |
| `IP_HASH_SALT` | 审计日志里 ip_hash 的盐。同样要与线上一致，否则历史 ip_hash 对不上 |

生成新值（新部署才需要）：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

> **迁移已有站点**：`PASSWORD_PEPPER` / `IP_HASH_SALT` 用 `wrangler secret list`
> 对不上就把线上 Worker 的 secrets 取出来照抄。这两个值变了 = 所有账号失效。

### 3. 出站邮件（可选，但强烈建议配）

不配 SMTP 时：密码找回退化成"联系管理员"，开赛提醒只写审计不发信，其余功能正常。

QQ 邮箱示例：

```ini
SMTP_HOST=smtp.qq.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=625071316@qq.com
SMTP_PASS=<QQ 邮箱设置里生成的「授权码」，不是登录密码>
SMTP_FROM=notify@你的域名
SMTP_FROM_NAME=HIVE
```

配了 SMTP 之后：
- 登录页的「忘记密码」变成**填邮箱直接发信**（不再需要玩家发信过来）；
- 开赛提醒能给任意收件人发（Workers 免费版只能发给已验证目的地）。

**发信送达率**要自己保证：在域名 DNS 里配好 SPF / DKIM / DMARC，
否则进垃圾箱或被大厂拒收。用 QQ 邮箱代发时，`SMTP_FROM` 最好设成 QQ 邮箱本身。

### 4. 创建 GitHub 部署用户（推荐，别用 root）

```bash
# 服务器上
useradd -m -s /bin/bash deploy
usermod -aG docker deploy
mkdir -p /home/deploy/.ssh && chmod 700 /home/deploy/.ssh
chown -R deploy:deploy /opt/hive
```

**本地**生成一对专用密钥：

```bash
ssh-keygen -t ed25519 -C "github-actions-hive" -f ./deploy_key -N ""
ssh-copy-id -i ./deploy_key.pub deploy@<server>
```

`deploy_key` 的内容（含 `-----BEGIN...` 到 `-----END...`）稍后填进 GitHub Secret。

### 5. 1Panel 建站

1Panel 左侧 **网站 → 创建网站 → 反向代理**：

| 字段 | 值 |
| --- | --- |
| 主域名 | `hive.你的域名` |
| 代理地址 | `http://127.0.0.1:8787` |
| 启用 HTTPS | 勾选，用 DNS 或 HTTP 验证申请 Let's Encrypt |

创建后在 **网站 → 配置 → 反向代理** 确认 `proxy_pass http://127.0.0.1:8787;`。
1Panel 默认会带上 `Host` / `X-Real-IP` / `X-Forwarded-For`，Hono 能正常取到真实 IP。

**gzip**（可选，容器自己不压缩，交给 OpenResty）：

```nginx
gzip on;
gzip_types text/plain text/css application/javascript application/json image/svg+xml;
gzip_min_length 1024;
```

> **不要**自己配 WebSocket，这个站没有实时功能。

### 6. Cloudflare DNS

如果域名托管在 Cloudflare：
- 新增 A 记录 `hive` → 服务器 IP
- **代理状态先设为「仅 DNS」**（灰色云朵）。橙色云朵会让流量先走 CF 再回源，
  而站点本来就在 CF 上跑，容易绕晕；试跑通过后再决定要不要开。

---

## 二、GitHub 配置

### Secrets（Settings → Secrets and variables → Actions → Secrets）

| 名称 | 说明 |
| --- | --- |
| `SSH_HOST` | 服务器 IP 或域名 |
| `SSH_USER` | `deploy` |
| `SSH_PRIVATE_KEY` | 上面生成的私钥**完整内容** |
| `SSH_PORT` | 可选，默认 22 |
| `SSH_KNOWN_HOSTS` | 可选。`ssh-keyscan <host>` 的输出。填了会启用严格主机校验 |

### Variables

**不需要。** 前端所有 API 都走同源 `/api`，没有构建期内联的变量——
所有配置都在服务器的 `shared/.env` 里。这是与 pixel-blog 最大的区别。

---

## 三、首次部署

```bash
git add deploy/ .github/ packages/api/src/server packages/api/src/db
git commit -m "feat: 支持自建服务器部署（Node + SQLite）"
git push origin main
```

打开 GitHub 仓库 **Actions → Deploy to VPS**，观察每一步：

1. `Typecheck` / `Unit tests` — 约 30 秒
2. `Build frontend` / `Build backend` — 约 1 分钟
3. `Upload artifact and deploy script` — 传约 10 MB
4. `Run remote deploy` — 服务器上：解包 → 切软链 → 构建镜像 → 重建容器 → 健康检查

成功后访问 `https://hive.你的域名` 验证。

### 手动触发

Actions 页面点 **Run workflow** 即可，用于只改了服务器配置、不想提交代码的场景。

---

## 四、日常运维

### 查看日志

```bash
# 1Panel 里：容器 → hive → 日志
docker logs -f hive --tail 100
```

### 查看版本历史与回滚

```bash
ls -lt /opt/hive/releases/
readlink -f /opt/hive/current
```

手动回滚到某个版本：

```bash
ln -sfn /opt/hive/releases/20261124-100000 /opt/hive/current
cd /opt/hive && docker compose up -d --force-recreate
```

脚本保留最近 5 个版本，自动清理更早的。

### 数据库备份（**必做**）

SQLite 只有一个文件，用 `VACUUM INTO` 拿一致快照（**直接 `cp` 在有写入时可能拿到半份事务**）。

仓库里带了一个脚本 `deploy/backup.sh`：

```bash
scp deploy/backup.sh root@<server>:/opt/hive/
ssh root@<server> 'chmod +x /opt/hive/backup.sh && /opt/hive/backup.sh'
```

它会：
1. 在容器内执行 `VACUUM INTO '/srv/data/.backup-tmp.db'`（原生在线备份，不影响写入）；
2. 把快照移到宿主机 `/opt/hive/backups/hive-<时间戳>.db`；
3. 只保留最近 14 份（`KEEP=30 ./backup.sh` 可改）。

在 1Panel **计划任务 → Shell 脚本**里配成每天一次：

```bash
/opt/hive/backup.sh
```

恢复：

```bash
docker compose -f /opt/hive/docker-compose.yml down
cp /opt/hive/backups/hive-20261124-173000.db /opt/hive/shared/data/hive.db
# WAL / SHM 必须一起删，否则会和新主库对不上
rm -f /opt/hive/shared/data/hive.db-wal /opt/hive/shared/data/hive.db-shm
docker compose -f /opt/hive/docker-compose.yml up -d
```

### 更新

直接 `git push main`，Actions 会重新构建并部署。健康检查失败会自动回滚上一版。

### 修改运行期密钥

改 `/opt/hive/shared/.env` 后：

```bash
cd /opt/hive && docker compose up -d --force-recreate
```

### 数据库迁移

容器启动时会先跑 `node migrate.mjs` 再起服务（见 Dockerfile 的 CMD），
所以**不需要手动迁移**。迁移幂等，重复执行安全。

想手动跑：

```bash
docker exec hive node /srv/app/migrate.mjs
```

---

## 五、从 Cloudflare 迁移数据

### 1. 导出线上 D1

```bash
# 本地，在仓库根目录
pnpm db:backup          # → backups/hive.sql
```

### 2. 在服务器上导入

仓库里带了一个脚本 `deploy/import-d1.sh`：

```bash
scp deploy/import-d1.sh backups/hive.sql root@<server>:/opt/hive/
ssh root@<server> 'chmod +x /opt/hive/import-d1.sh && /opt/hive/import-d1.sh /opt/hive/hive.sql'
```

它做的事（顺序很重要）：

1. **先跑 `backup.sh` 备份当前库**——导入会覆盖数据；
2. 把 `.sql` 拷进容器；
3. `PRAGMA foreign_keys = OFF` → `BEGIN` → 清空同名表 → `exec(整份 SQL)` → `COMMIT`；
4. `PRAGMA foreign_keys = ON`，跑 `foreign_key_check` + `integrity_check` 校验；
5. 重启容器，让 WAL 重新打开。

> **为什么不能直接 `exec` 整份 SQL**：D1 的导出里表顺序不保证满足外键依赖
> （`INSERT INTO users` 可能早于 `CREATE TABLE invite_codes`）。D1 自己靠
> `defer_foreign_keys` 把检查推到提交时，但那要求**被引用的表已经存在**。
> 所以整段导入期间必须关外键，灌完再打开校验。

### 3. 校验

脚本结束时会打印各表行数。再手动确认一次：

```bash
docker exec hive node -e "
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync('/srv/data/hive.db');
for (const t of ['users','events','registrations','matches','app_settings']) {
  console.log(t, db.prepare('SELECT count(*) c FROM ' + t).get().c);
}
"
```

用原来的管理员账号登录一次，确认 `PASSWORD_PEPPER` 与线上一致
（不一致的表现是"用户名密码都对，但就是登不上"）。

---

## 六、和 Workers 版的差异

| 项目 | Workers | 自建 |
| --- | --- | --- |
| 数据库 | D1（SQLite） | SQLite 文件（`node:sqlite`，同一个 D1 兼容层） |
| 静态资源 | Assets（`_headers` 加安全头） | `server/static.ts` 加同一套头 |
| 定时任务 | Cron Triggers | `server/scheduler.ts` 的 setTimeout |
| 出站邮件 | `send_email` 绑定（只发给已验证地址） | SMTP（可以发给任何人） |
| 密码找回 | 玩家发信到 reset@，Worker 回信 | 填邮箱直接发信（`RESET_FLOW=self`） |
| 收信 | Email Routing → Worker | **不支持**（没有收信入口） |
| 版本回滚 | `wrangler versions deploy` | `current` 符号链接 + 重新构建镜像 |

代码是同一份：`packages/api/src/app.ts` 与所有 routes / services 完全共用，
差异只在入口层（`src/index.ts` vs `src/server/index.ts`）与邮件/数据库的绑定。

---

## 七、常见问题

**`node:sqlite` 打印 `ExperimentalWarning: SQLite is an experimental feature`**
正常现象。这个模块在 Node 22/24 里仍标着 experimental，但 API 已经稳定，
我们只用了 `DatabaseSync` 的 `prepare/run/get/all/exec` 这几个最基础的接口。
**因此容器里的 Node 大版本是钉死的**（`node:22-bookworm-slim`）：升级 Node 前先在
本地跑一遍 `pnpm test`（含 9 条 D1 兼容层契约测试），确认没有行为变化再改 Dockerfile。
想彻底消掉这条警告，可以在启动命令上加 `--disable-warning=ExperimentalWarning`。

**容器起来了但 8787 端口不通**
看 `docker logs hive`。常见是 `shared/.env` 缺 `PASSWORD_PEPPER` / `IP_HASH_SALT`，
进程启动时直接 `process.exit(1)`（宁可起不来，也别带半套配置对外服务）。

**切版本后访问的还是旧内容**
镜像里带代码，`remote-deploy.sh` 用了 `--force-recreate`；如果手工操作，
记得不是 `restart` 而是 `up -d --force-recreate`。

**登录 200 但页面仍未登录**
`/api/me` 大概 500 了，看日志里的 `no such column`——迁移没跑。
容器启动会自动迁移；如果是手工起的服务，先 `node migrate.mjs`。

**改了 `PASSWORD_PEPPER` 之后所有人都登不上**
这是设计如此（pepper 参与哈希）。迁移时务必照抄线上值。

**`SQLITE_BUSY` / 数据库锁**
容器里只有一个进程写，正常不会撞。备份脚本如果用 `cp` 直接拷正在写的库，
可能出现；用 `VACUUM INTO` 或 `.backup`，别用 `cp`。

**健康检查一直失败**
`curl http://127.0.0.1:8787/api/health` 手动试。失败原因按顺序查：
容器是否在跑 → 端口是否绑定 → `.env` 是否缺项 → 数据库文件权限（容器内是 `node` 用户，
`shared/data` 必须可写）。

**想完全弃用 Cloudflare**
确认 `https://hive.你的域名` 一切正常（首页、赛事、排行榜、战绩、绑定 Steam）后，
把 `cwa1e.top` 的 DNS 从 Worker 改指服务器 IP，再在 1Panel 里把主域名改过去。
注意 `apps/web/src/lib/contact.ts` 里的 `reset@` 地址与 `docs/` 里的硬编码域名。
