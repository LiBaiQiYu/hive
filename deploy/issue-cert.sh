#!/bin/bash
# ---------------------------------------------------------------------------
# HIVE —— 用 acme.sh 签 Let's Encrypt 证书（HTTP-01 验证）
#
# 前提：hive-new.cwa1e.top 的 A 记录已经指向本机，且 80 端口从公网可达。
#       nginx 里必须有 ACME 验证路径（20-hive.conf 已经有）。
#
# 用法：
#   /opt/hive/issue-cert.sh              # 首次签发 + 装到 openresty
#   /opt/hive/issue-cert.sh --check      # 只看证书状态
#
# 签完会 reload openresty。续期靠 acme.sh 自己的 cron。
# ---------------------------------------------------------------------------
set -Eeuo pipefail

DOMAIN="${DOMAIN:-hive-new.cwa1e.top}"
ACME="/root/.acme.sh/acme.sh"
WEBROOT="/opt/1panel/apps/openresty/openresty/root"
SSL_DIR="/opt/1panel/apps/openresty/openresty/www/ssl/$DOMAIN"
CONTAINER="1Panel-openresty-Xy7A"

log() { printf '\n\033[1;36m[cert]\033[0m %s\n' "$*"; }
ok()  { printf '\033[1;32m[  ok  ]\033[0m %s\n' "$*"; }
die() { printf '\n\033[1;31m[ fail ]\033[0m %s\n' "$*" >&2; exit 1; }

[ -x "$ACME" ] || die "找不到 $ACME"
export LE_WORKING_DIR=/root/.acme.sh

if [ "${1:-}" = "--check" ]; then
  "$ACME" --list
  echo
  if [ -f "$SSL_DIR/fullchain.pem" ]; then
    openssl x509 -in "$SSL_DIR/fullchain.pem" -noout -subject -dates
  else
    echo "证书还没安装到 $SSL_DIR"
  fi
  exit 0
fi

# ---------------------------------------------------------------- 前置检查 --
# 不比对"本机公网 IP"：阿里云 ECS 的 39.x 是 NAT 映射的，网卡上只有内网
# 172.x/10.x，从机器内部永远查不出自己的公网地址（国内也常连不上 ipify）。
# 换个更直接的判据：域名能解析，且解析到的地址上 80 端口能应答 —— 这才是
# HTTP-01 真正的需求。

RESOLVED="$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || true)"
[ -n "$RESOLVED" ] || die "DNS 还没生效：$DOMAIN 解析不到地址。
      先在 Cloudflare 加一条 A 记录指向本机公网 IP，
      代理状态选「仅 DNS」（灰色云朵）；开橙色云朵会让 ACME 验证被 CF 接走而失败。"

log "域名 $DOMAIN 解析到 $RESOLVED"

if ! curl -sS --max-time 10 -o /dev/null "http://$DOMAIN/.well-known/acme-challenge/probe" 2>/dev/null; then
  die "从本机访问 http://$DOMAIN/ 失败。排查顺序：
        1. 云厂商安全组是否放行 80/tcp
        2. 服务器 firewalld 是否放行 80（firewall-cmd --list-ports）
        3. nginx 是否在监听 80（ss -lnt | grep ':80 '）
        4. DNS 是否刚改、还在传播"
fi
ok "80 端口可达"

# ------------------------------------------------------------------ 签发 --
log "向 Let's Encrypt 申请证书（HTTP-01）"
"$ACME" --issue -d "$DOMAIN" --webroot "$WEBROOT" --keylength ec-256 \
  || die "签发失败。常见原因：DNS 未生效 / 80 端口被安全组挡住 / 该域名近期签得太频繁（Let's Encrypt 限流，等 1 小时）"

# ------------------------------------------------------------------ 安装 --
log "安装证书到 $SSL_DIR"
mkdir -p "$SSL_DIR"
"$ACME" --install-cert -d "$DOMAIN" --ecc \
  --key-file       "$SSL_DIR/privkey.pem" \
  --fullchain-file "$SSL_DIR/fullchain.pem" \
  --reloadcmd      "docker exec $CONTAINER openresty -s reload"

chmod 600 "$SSL_DIR/privkey.pem"

ok "证书就绪"
openssl x509 -in "$SSL_DIR/fullchain.pem" -noout -subject -dates

cat <<EOF

下一步：装 HTTPS 版 nginx 配置
  /opt/hive/apply-nginx.sh --https

EOF
