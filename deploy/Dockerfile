# ---------------------------------------------------------------------------
# HIVE —— 自建服务器运行时镜像
#
# 构建**不在这里做**：GitHub Actions 用 4 核 16G 的机器跑 pnpm build，
# 只把四个产物（server.mjs / migrate.mjs / public / migrations）传到服务器。
#
# 这个镜像里**没有任何 npm install**：server.mjs 已由 esbuild 把 nodemailer
# 一起打进来（只有 node: 内置模块留给运行时）。好处是部署不依赖
# npm registry 可达性——国内服务器常常卡在这一步，而且省掉一次网络安装。
#
# 构建上下文是 release 目录（deploy/docker-compose.yml 的 `build: ./current`），
# 所以下面 COPY 的都是 release 里的文件；Dockerfile 本身由部署脚本复制进去。
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim

# tini 转发信号：没有它时 `docker stop` 会让 node 直接 SIGKILL，
# 数据库来不及把 WAL 落盘（优雅退出逻辑在 server/index.ts）。
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    DB_PATH=/srv/data/hive.db \
    STATIC_DIR=/srv/app/public \
    MIGRATIONS_DIR=/srv/app/migrations

WORKDIR /srv

# 产物按 release 目录结构复制进来（无 node_modules 需要）
COPY server.mjs /srv/app/server.mjs
COPY migrate.mjs /srv/app/migrate.mjs
COPY public /srv/app/public
COPY migrations /srv/app/migrations

# data/ 由 compose 挂卷；这里只保证容器内可写
RUN mkdir -p /srv/data && chown -R node:node /srv

USER node

EXPOSE 8787

# 健康检查打 /api/health（静态层不查库，接口层才代表"真能用"）
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
# 先迁移再起服务：两步都幂等，迁移失败则容器直接退出（不会带着旧表结构对外服务）
CMD ["sh", "-c", "node /srv/app/migrate.mjs && exec node /srv/app/server.mjs"]
