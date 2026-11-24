# ---------------------------------------------------------------------------
# HIVE —— 自建服务器运行时镜像
#
# 构建**不在这里做**：GitHub Actions 用 4 核 16G 的机器跑 pnpm build，
# 只把三个产物（server.mjs / migrate.mjs / public + migrations）传到服务器。
# 这个镜像只负责「带着 Node + 运行期依赖跑起来」。
#
# 构建上下文是 release 目录（deploy/docker-compose.yml 的 context: ./current），
# 所以下面 COPY 的都是 release 里的文件 —— 代码不进 bind mount，
# 每次部署由 CI 构建新镜像，天然避开「符号链接切换后 Docker 还挂旧目录」的坑。
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

# 唯一的运行期 npm 依赖：nodemailer（server.mjs 里被 esbuild 标成 external 的那个）
RUN npm install --omit=dev --no-audit --no-fund nodemailer@10 && npm cache clean --force

# 产物按 release 目录结构复制进来
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
CMD ["sh", "-c", "node /srv/app/migrate.mjs && exec node /srv/app/server.mjs"]
