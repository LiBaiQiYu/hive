#!/bin/bash
# ---------------------------------------------------------------------------
# HIVE —— 把 OpenResty 配置装上去并 reload
#
# 用法（在服务器上）：
#   /opt/hive/apply-nginx.sh                 # 装 HTTP 版本（无证书时用）
#   /opt/hive/apply-nginx.sh --https         # 装 HTTPS 版本（需先签好证书）
#
# 会先 nginx -t 校验，通过才 reload；失败自动还原上一份配置。
# ---------------------------------------------------------------------------
set -Eeuo pipefail

DOMAIN="${DOMAIN:-hive-new.cwa1e.top}"
CONF_DIR="/opt/1panel/apps/openresty/openresty/conf/conf.d"
TARGET="$CONF_DIR/20-hive.conf"
SRC_DIR="${SRC_DIR:-/opt/hive}"
CONTAINER="1Panel-openresty-Xy7A"
MODE="${1:-http}"

log() { printf '\n\033[1;36m[nginx]\033[0m %s\n' "$*"; }
ok()  { printf '\033[1;32m[  ok  ]\033[0m %s\n' "$*"; }
die() { printf '\n\033[1;31m[ fail ]\033[0m %s\n' "$*" >&2; exit 1; }

[ -d "$CONF_DIR" ] || die "找不到 $CONF_DIR"

if [ "$MODE" = "--https" ]; then
  SRC="$SRC_DIR/nginx-hive-https.conf"
  [ -f "$SRC" ] || die "缺少 $SRC"
  [ -f "/opt/1panel/apps/openresty/openresty/www/ssl/$DOMAIN/fullchain.pem" ] || \
    die "证书还没签：先跑 /opt/hive/issue-cert.sh"
else
  SRC="$SRC_DIR/nginx-hive.conf"
  [ -f "$SRC" ] || die "缺少 $SRC"
fi

# 备份现有配置（有才备份）
if [ -f "$TARGET" ]; then
  cp "$TARGET" "$TARGET.bak.$(date +%Y%m%d-%H%M%S)"
fi

log "安装 $MODE 配置到 $TARGET"
cp "$SRC" "$TARGET"

log "校验配置"
if ! docker exec "$CONTAINER" openresty -t 2>&1 | tail -3; then
  warn="配置校验失败，正在还原"
  printf '\033[1;33m[ warn ]\033[0m %s\n' "$warn"
  LATEST_BAK="$(ls -1t "$TARGET".bak.* 2>/dev/null | head -1 || true)"
  if [ -n "$LATEST_BAK" ]; then
    mv "$LATEST_BAK" "$TARGET"
  else
    rm -f "$TARGET"
  fi
  docker exec "$CONTAINER" openresty -t 2>&1 | tail -3
  die "配置校验失败，已还原"
fi

log "重载 OpenResty"
docker exec "$CONTAINER" openresty -s reload
ok "完成：http://$DOMAIN"
