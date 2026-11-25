#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# HIVE —— 服务器端部署脚本（由 GitHub Actions 通过 SSH 调用，也可手工执行）
#
# 职责：接收 CI 传上来的产物包 → 解压到新 release → 切换 current →
#       构建/重建容器 → 健康检查，失败则自动回滚上一个版本。
#
# 用法：
#   ./remote-deploy.sh /tmp/hive-20261124.tar.gz
#
# 环境变量（可选）：
#   APP_DIR        默认 /opt/hive
#   PORT           健康检查端口，默认 8787
#   KEEP_RELEASES  保留的历史版本数，默认 5
# ---------------------------------------------------------------------------
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/hive}"
PORT="${PORT:-8787}"
KEEP_RELEASES="${KEEP_RELEASES:-5}"
ARCHIVE="${1:-}"

RELEASES_DIR="$APP_DIR/releases"
CURRENT_LINK="$APP_DIR/current"
COMPOSE_FILE="$APP_DIR/docker-compose.yml"
DOCKERFILE="$APP_DIR/Dockerfile"
HEALTH_URL="http://127.0.0.1:${PORT}/api/health"
SERVICE="hive"
# 分开存：IMAGE_NAME 不带 tag。之前写成 IMAGE="hive-app:latest" 再拼
# `$IMAGE:$STAMP`，得到 "hive-app:latest:2026..." 这种非法引用，
# docker tag 直接失败——而失败被 `|| true` 吞掉了，回滚时才发现没有历史镜像。
IMAGE_NAME="hive-app"
IMAGE="$IMAGE_NAME:latest"

log()  { printf '\n\033[1;36m[deploy]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[  ok  ]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[ warn ]\033[0m %s\n' "$*"; }
die()  { printf '\n\033[1;31m[ fail ]\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- 前置检查 --
[ -n "$ARCHIVE" ] || die "缺少产物包参数：./remote-deploy.sh <archive.tar.gz>"
[ -f "$ARCHIVE" ] || die "产物包不存在：$ARCHIVE"
[ -f "$COMPOSE_FILE" ] || die "找不到 $COMPOSE_FILE（先按 deploy/README.md 完成首次初始化）"
[ -f "$DOCKERFILE" ] || die "找不到 $DOCKERFILE"
[ -f "$APP_DIR/shared/.env" ] || die "找不到 $APP_DIR/shared/.env（首次部署需要先配置环境变量）"

command -v docker >/dev/null 2>&1 || die "未安装 docker"
command -v curl >/dev/null 2>&1 || die "未安装 curl（健康检查需要）：apt install -y curl"

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  die "未找到 docker compose"
fi

compose() { "${COMPOSE[@]}" -f "$COMPOSE_FILE" "$@"; }

# ---------------------------------------------------------------- 解包产物 --
STAMP="$(date +%Y%m%d-%H%M%S)"
NEW_RELEASE="$RELEASES_DIR/$STAMP"
mkdir -p "$RELEASES_DIR" "$APP_DIR/shared/data"

# 数据目录必须归容器里的 node 用户（uid 1000）所有：
# 容器以 node 身份跑，宿主机目录是 root:root 755 时 SQLite 打不开文件
# （报 "unable to open database file"，看起来像路径错，其实是权限）。
# 反复修正不报错，第一次部署和后续升级都能跑。
if [ "$(stat -c %u "$APP_DIR/shared/data" 2>/dev/null || echo 1000)" != "1000" ]; then
  chown -R 1000:1000 "$APP_DIR/shared/data" 2>/dev/null || \
    warn "无法把 shared/data 改成 uid 1000（若不是 root 执行，请先手工 chown）"
fi
chmod 750 "$APP_DIR/shared/data" 2>/dev/null || true

log "解包产物到 $NEW_RELEASE"
mkdir -p "$NEW_RELEASE"
tar -xzf "$ARCHIVE" -C "$NEW_RELEASE"

[ -f "$NEW_RELEASE/server.mjs" ] || die "产物里没有 server.mjs，包内容不对"
[ -f "$NEW_RELEASE/migrate.mjs" ] || die "产物里没有 migrate.mjs"
[ -d "$NEW_RELEASE/public" ] || die "产物里没有 public/（前端构建产物）"
[ -d "$NEW_RELEASE/migrations" ] || die "产物里没有 migrations/"

# Dockerfile 是"构建上下文的一部分"：compose 的 build 指向 ./current，
# 所以它必须坐在 release 目录里。由部署脚本从 APP_DIR 复制进去，
# 这样每个历史版本都自带当时那份 Dockerfile，回滚时行为一致。
cp "$DOCKERFILE" "$NEW_RELEASE/Dockerfile"
ok "解包完成（$(du -sh "$NEW_RELEASE" | cut -f1)）"

# ------------------------------------------------------------------ 切版本 --
PREVIOUS_RELEASE=""
if [ -L "$CURRENT_LINK" ]; then
  PREVIOUS_RELEASE="$(readlink -f "$CURRENT_LINK")"
elif [ -d "$CURRENT_LINK" ]; then
  warn "current 是真实目录而不是符号链接，先备份为 current.bak"
  mv "$CURRENT_LINK" "$APP_DIR/current.bak.$(date +%s)"
fi

log "切换 current -> $STAMP"
ln -sfn "$NEW_RELEASE" "$CURRENT_LINK"

# ------------------------------------------------------------------ 构建镜像 --
# 用 --build 而不是预先 build：Dockerfile 里的层会缓存，代码不变时几乎零耗时
log "构建镜像"
compose build "$SERVICE"

# 给这次构建打上版本 tag：回滚时直接 retag，不用重新构建（快，也不依赖构建环境）
# 失败要喊出来：没有历史 tag，回滚就只能重新构建（慢且依赖构建环境）
if ! docker tag "$IMAGE" "$IMAGE_NAME:$STAMP"; then
  warn "给镜像打版本 tag 失败（$IMAGE_NAME:$STAMP），回滚将退化为重新构建"
fi

# ------------------------------------------------------------------ 重启服务 --
# 用 up -d --force-recreate 而不是 restart：镜像 tag 没变（都是 hive-app:latest），
# 只 restart 会继续跑旧的容器快照，新构建的镜像根本不会生效。
log "重建容器"
compose up -d --force-recreate --remove-orphans

# ------------------------------------------------------------------ 健康检查 --
log "等待服务就绪（最多 90 秒）"
healthy=0
for i in $(seq 1 45); do
  if curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; then
    healthy=1
    ok "健康检查通过（第 ${i} 次尝试）"
    break
  fi
  sleep 2
done

# ------------------------------------------------------------------ 失败回滚 --
if [ "$healthy" -ne 1 ]; then
  warn "健康检查未通过，最近容器日志："
  compose logs --tail 60 "$SERVICE" || true

  if [ -n "$PREVIOUS_RELEASE" ] && [ -d "$PREVIOUS_RELEASE" ]; then
    warn "回滚到上一个版本：$PREVIOUS_RELEASE"
    ln -sfn "$PREVIOUS_RELEASE" "$CURRENT_LINK"

    # 镜像 tag 是 hive-app:latest，直接 recreate 会继续跑新代码。
    # 优先用上次构建留下的版本 tag 重新打回去（秒级、不依赖构建）；
    # 没有那个 tag（老版本没打）才退化成重新构建。
    PREV_TAG="$IMAGE_NAME:$(basename "$PREVIOUS_RELEASE")"
    if docker image inspect "$PREV_TAG" >/dev/null 2>&1; then
      log "用已有镜像回滚：$PREV_TAG"
      docker tag "$PREV_TAG" "$IMAGE"
    else
      warn "没找到 $PREV_TAG，重新构建上一版镜像"
      compose build "$SERVICE" || warn "重建失败，尝试直接用现有镜像启动"
    fi

    compose up -d --force-recreate --remove-orphans || true
    sleep 5
    if curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; then
      warn "已回滚，旧版本恢复服务"
    else
      die "回滚后仍然不健康，请登录服务器检查：docker logs hive"
    fi
  else
    die "首次部署就失败了，没有可回滚的版本，请检查日志"
  fi

  rm -rf "$NEW_RELEASE"
  exit 1
fi

# -------------------------------------------------------------- 清理旧版本 --
log "清理历史版本（保留最近 $KEEP_RELEASES 个）"
cd "$RELEASES_DIR"
# shellcheck disable=SC2012
ls -1dt */ 2>/dev/null | tail -n +"$((KEEP_RELEASES + 1))" | while read -r old; do
  # 不要删掉正在使用的那一个
  if [ "$(readlink -f "$CURRENT_LINK")" != "$(readlink -f "$old")" ]; then
    rm -rf -- "$old"
    # 对应的版本镜像也一起清掉，否则磁盘会被一堆 hive-app:<时间戳> 吃掉
    docker rmi "$IMAGE_NAME:$(basename "$old")" >/dev/null 2>&1 || true
    ok "已删除旧版本 $old"
  fi
done

rm -f "$ARCHIVE" 2>/dev/null || true

ok "部署完成：$(readlink -f "$CURRENT_LINK")"
