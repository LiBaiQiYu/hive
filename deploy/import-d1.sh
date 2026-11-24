#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# HIVE —— 把 Cloudflare D1 的导出文件导入到自建 SQLite
#
# 用法：
#   1) 本地（仓库根目录）导出线上库：
#        pnpm db:backup            # → backups/hive.sql
#   2) 上传到服务器：
#        scp backups/hive.sql root@<server>:/opt/hive/hive.sql
#   3) 在服务器上导入（会覆盖现有数据，务必先备份）：
#        /opt/hive/import-d1.sh /opt/hive/hive.sql
#
# 为什么不是简单 exec 整份 SQL：
#   D1 的导出里表顺序不保证满足外键依赖（INSERT users 可能早于
#   CREATE TABLE invite_codes）。D1 自己靠 defer_foreign_keys 把检查推到提交时，
#   但那要求被引用的表**已经存在**。所以这里整段导入期间关闭外键，
#   灌完再打开并跑 foreign_key_check / integrity_check 校验。
# ---------------------------------------------------------------------------
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/hive}"
SERVICE="${SERVICE:-hive}"
SQL_FILE="${1:-}"

log() { printf '[import] %s\n' "$*"; }
die() { printf '[import] 失败：%s\n' "$*" >&2; exit 1; }

[ -n "$SQL_FILE" ] || die "用法：$0 <hive.sql>"
[ -f "$SQL_FILE" ] || die "找不到 $SQL_FILE"
docker ps --format '{{.Names}}' | grep -qx "$SERVICE" || die "容器 $SERVICE 没在运行"

# ---------------------------------------------------------------- 先备份 --
if [ -x "$APP_DIR/backup.sh" ]; then
  log "先备份当前数据"
  "$APP_DIR/backup.sh" || die "备份失败，已中止导入"
else
  log "警告：没找到 $APP_DIR/backup.sh，请自行确认已有备份"
  sleep 3
fi

log "把 $SQL_FILE 拷进容器"
docker cp "$SQL_FILE" "$SERVICE:/tmp/hive-import.sql"

log "导入（外键先关，整份脚本包在一个事务里）"
docker exec "$SERVICE" node -e "
const { readFileSync } = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const dbPath = process.env.DB_PATH || '/srv/data/hive.db';
const db = new DatabaseSync(dbPath);
const sql = readFileSync('/tmp/hive-import.sql', 'utf8');

db.exec('PRAGMA foreign_keys = OFF');
db.exec('BEGIN');
try {
  // D1 的导出自带 CREATE TABLE，先清空同名表避免主键冲突
  const names = db
    .prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'\")
    .all()
    .map((r) => r.name)
    .filter((n) => n !== 'd1_migrations');
  for (const name of names) {
    try { db.exec('DROP TABLE IF EXISTS \"' + name + '\"'); } catch {}
  }
  db.exec(sql);
  db.exec('COMMIT');
} catch (err) {
  db.exec('ROLLBACK');
  console.error('import failed:', err.message);
  process.exit(1);
}
db.exec('PRAGMA foreign_keys = ON');

const violations = db.prepare('PRAGMA foreign_key_check').all();
const integrity = db.prepare('PRAGMA integrity_check').get();
console.log('integrity_check:', integrity.integrity_check);
console.log('foreign_key_check violations:', violations.length);

const counts = {};
for (const t of ['users', 'events', 'registrations', 'player_ratings', 'audit_logs', 'd1_migrations']) {
  counts[t] = db.prepare('SELECT count(*) AS c FROM ' + t).get().c;
}
console.log('counts:', JSON.stringify(counts));
db.close();

if (violations.length > 0) process.exit(2);
"

docker exec "$SERVICE" rm -f /tmp/hive-import.sql
rm -f "$SQL_FILE"

log "重启容器让 WAL 重新打开"
docker compose -f "$APP_DIR/docker-compose.yml" restart "$SERVICE"

log "完成。请用原管理员账号登录验证（PASSWORD_PEPPER 必须与导出库一致）"
