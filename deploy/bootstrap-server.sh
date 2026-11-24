#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# HIVE —— 服务器首次初始化（只需手动执行一次）
#
# 做的事：
#   1. 建立 /opt/hive 目录骨架
#   2. 检查 docker-compose.yml / Dockerfile 是否已上传
#   3. 生成 shared/.env 模板（权限 600）与 shared/data 目录
#   4. 打印下一步该做什么
#
# 用法：
#   scp deploy/bootstrap-server.sh root@<server>:/tmp/
#   ssh root@<server> 'bash /tmp/bootstrap-server.sh'
# ---------------------------------------------------------------------------
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/hive}"

log() { printf '\n\033[1;36m[bootstrap]\033[0m %s\n' "$*"; }
ok()  { printf '\033[1;32m[   ok   ]\033[0m %s\n' "$*"; }

log "创建目录结构：$APP_DIR"
mkdir -p "$APP_DIR/releases" "$APP_DIR/shared/data"
chmod 750 "$APP_DIR/shared"

if [ ! -f "$APP_DIR/docker-compose.yml" ]; then
  log "docker-compose.yml 需要从仓库 deploy/ 目录复制过来"
  log "（本脚本不内嵌它，避免两处维护；先 scp deploy/docker-compose.yml $APP_DIR/）"
else
  ok "docker-compose.yml 已存在"
fi

if [ ! -f "$APP_DIR/Dockerfile" ]; then
  log "Dockerfile 需要从仓库 deploy/ 目录复制过来：scp deploy/Dockerfile $APP_DIR/"
else
  ok "Dockerfile 已存在"
fi

if [ ! -f "$APP_DIR/shared/.env" ]; then
  log "创建 shared/.env 模板"
  cat >"$APP_DIR/shared/.env" <<'ENVFILE'
# HIVE 运行期环境变量（由 bootstrap-server.sh 生成，请填写真实值）
# 修改后需要重建容器：cd /opt/hive && docker compose up -d --force-recreate

# ---- 必填 ----
# 对外访问地址（含协议）。Steam 回调的 realm 与 return_to 都由它推导，
# 配错了的表现是「Steam 授权完回来变成未登录」。
APP_ORIGIN=https://hive.example.com

# 密码哈希的 pepper：改它 = 所有现有密码失效。
# 生成：node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
PASSWORD_PEPPER=

# IP 哈希盐（审计日志里存 ip_hash，不存明文 IP）
IP_HASH_SALT=

# ---- 出站邮件（不填则密码找回/开赛提醒只记审计不发信）----
SMTP_HOST=
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=
# QQ 邮箱要填「授权码」，不是登录密码
SMTP_PASS=
SMTP_FROM=
SMTP_FROM_NAME=HIVE

# ---- 可选 ----
APP_ENV=production
SESSION_TTL_DAYS=14
SESSION_IDLE_TIMEOUT_HOURS=72
PASSWORD_PBKDF2_ITERATIONS=120000
ADMIN_ADJUSTMENT_LIMIT=150
AUTO_FINALIZE_ODD=false
STEAM_WEB_API_KEY=
STRATZ_API_TOKEN=
AUDIT_RETENTION_DAYS=365

# 密码找回走哪条路。留空 = 配了 SMTP 就用 self，否则 admin
RESET_FLOW=
ENVFILE
  chmod 600 "$APP_DIR/shared/.env"
  ok "已生成 $APP_DIR/shared/.env（权限 600）"
else
  ok "shared/.env 已存在，保持不变"
fi

log "目录检查"
ls -la "$APP_DIR"

cat <<EOF

下一步：
  1. 编辑 $APP_DIR/shared/.env 填真实值（至少 APP_ORIGIN / PASSWORD_PEPPER / IP_HASH_SALT）
  2. 在 1Panel 创建「反向代理」网站，代理到 http://127.0.0.1:8787
  3. 在 1Panel 计划任务里加一条 SQLite 备份（见 deploy/README.md）
  4. 配置 GitHub Secrets 后 push 代码，触发首次自动部署

EOF
