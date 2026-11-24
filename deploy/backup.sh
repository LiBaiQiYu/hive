#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# HIVE —— SQLite 在线备份（建议做成 1Panel 计划任务，每天跑一次）
#
# 为什么不用 cp：数据库开着 WAL，直接拷主库文件可能拿到"半份事务"，
# 恢复时表现为丢数据或库损坏。`VACUUM INTO` 是 SQLite 原生的在线备份，
# 会在一个读事务里生成一致的完整副本，不影响正在跑的写入。
#
# 用法：
#   ./backup.sh                     # 备份到 /opt/hive/backups
#   KEEP=30 ./backup.sh             # 保留 30 份
#   APP_DIR=/opt/hive ./backup.sh
#
# 退出码：0 成功（含"无需备份"不发生的情况），非 0 失败。
# ---------------------------------------------------------------------------
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/hive}"
KEEP="${KEEP:-14}"
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/backups}"
SERVICE="${SERVICE:-hive}"
STAMP="$(date +%Y%m%d-%H%M%S)"
TARGET="hive-$STAMP.db"

log() { printf '[backup] %s\n' "$*"; }
die() { printf '[backup] 失败：%s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "未安装 docker"
docker ps --format '{{.Names}}' | grep -qx "$SERVICE" || die "容器 $SERVICE 没在运行"

mkdir -p "$BACKUP_DIR"

# 在容器内做 VACUUM INTO：文件落在挂载卷里，宿主机能直接看到，
# 不用 docker cp（少一次全量拷贝，也不会读到写了一半的文件）
log "生成快照 $TARGET"
docker exec "$SERVICE" node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.env.DB_PATH || '/srv/data/hive.db');
db.exec(\"VACUUM INTO '/srv/data/.backup-tmp.db'\");
db.close();
" || die "VACUUM INTO 失败"

mv -f "$APP_DIR/shared/data/.backup-tmp.db" "$BACKUP_DIR/$TARGET"

SIZE="$(du -h "$BACKUP_DIR/$TARGET" | cut -f1)"
log "完成：$BACKUP_DIR/$TARGET（$SIZE）"

# 只留最近 $KEEP 份
if [ "$KEEP" -gt 0 ]; then
  ls -1t "$BACKUP_DIR"/hive-*.db 2>/dev/null | tail -n +"$((KEEP + 1))" | while read -r old; do
    rm -f -- "$old"
    log "删除旧备份 $(basename "$old")"
  done
fi
