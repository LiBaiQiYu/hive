"""校验 packages/database/migrations/0001_init.sql 能否真实执行，并验证关键不变量。

不是单元测试，是"这份 DDL 是否说得出、做得到"的快速自检：
用真实 SQLite（本地 3.50.4）建库、灌最小数据、故意触发约束。
"""
import sqlite3
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[3]
MIGRATIONS_DIR = ROOT / "packages" / "database" / "migrations"
SQL_FILES = sorted(MIGRATIONS_DIR.glob("*.sql"))
NOW = 1761822000000  # 2026-10-30T15:00:00+08:00 附近的毫秒时间戳


def new_db():
    con = sqlite3.connect(":memory:")
    con.execute("PRAGMA foreign_keys = ON")
    for path in SQL_FILES:
        con.executescript(path.read_text(encoding="utf-8"))
    return con


def expect_fail(con, label, sql, params=()):
    try:
        con.execute(sql, params)
    except sqlite3.Error as exc:
        print(f"  [ok] 拒绝: {label} -> {type(exc).__name__}")
        con.rollback()
        return True
    print(f"  [FAIL] 未拒绝: {label}")
    return False


def main() -> int:
    con = new_db()
    tables = [r[0] for r in con.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )]
    indexes = [r[0] for r in con.execute(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'ux_%' OR name LIKE 'idx_%' ORDER BY name"
    )]
    print(f"表数量: {len(tables)}")
    print("  " + ", ".join(tables))
    print(f"索引数量: {len(indexes)}")

    for (name,) in con.execute("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%'").fetchall():
        pass

    bad_fk = con.execute("PRAGMA foreign_key_check").fetchall()
    print(f"foreign_key_check: {'clean' if not bad_fk else bad_fk}")

    # ---- 最小数据集 ----
    def insert_user(uid, username, role="PLAYER"):
        con.execute(
            """INSERT INTO users (id, username, display_name, email, password_hash, role, created_at, updated_at)
               VALUES (?, ?, ?, ?, 'x', ?, ?, ?)""",
            (uid, username, username.upper(), f"{username}@hive.test", role, NOW, NOW),
        )

    insert_user("u1", "player_a")
    insert_user("u2", "player_b")
    insert_user("u3", "admin", "ADMIN")
    for uid in ("u1", "u2"):
        con.execute(
            """INSERT INTO player_ratings (id, user_id, system_rating, admin_adjustment, effective_rating, updated_at)
               VALUES (?, ?, 720, 50, 770, ?)""",
            (f"r_{uid}", uid, NOW),
        )
    con.execute(
        """INSERT INTO events (id, title, status, capacity, created_by, created_at, updated_at)
           VALUES ('e1', 'HIVE 第 01 期周末内战', 'REGISTRATION_OPEN', 20, 'u3', ?, ?)""",
        (NOW, NOW),
    )
    con.execute(
        """INSERT INTO registrations (id, event_id, user_id, status, position_preference,
             system_rating_snapshot, admin_adjustment_snapshot, effective_rating_snapshot, snapshot_at, created_at, updated_at)
           VALUES ('reg1', 'e1', 'u1', 'CONFIRMED', 2, 720, 50, 770, ?, ?, ?)""",
        (NOW, NOW, NOW),
    )
    con.execute(
        """INSERT INTO matches (id, event_id, match_no, status, created_by, created_at, updated_at)
           VALUES ('m1', 'e1', 1, 'DRAFT', 'u3', ?, ?)""",
        (NOW, NOW),
    )
    for side, tid in (("RADIANT", "t1"), ("DIRE", "t2")):
        con.execute(
            """INSERT INTO teams (id, match_id, event_id, side, name, created_at, updated_at)
               VALUES (?, 'm1', 'e1', ?, ?, ?, ?)""",
            (tid, side, side.title(), NOW, NOW),
        )
    con.execute(
        """INSERT INTO team_members (id, team_id, match_id, user_id, team_side, assigned_position,
             system_rating_snapshot, admin_adjustment_snapshot, effective_rating_snapshot, created_at)
           VALUES ('tm1', 't1', 'm1', 'u1', 'RADIANT', 2, 720, 50, 770, ?)""",
        (NOW,),
    )
    con.execute(
        """INSERT INTO match_player_stats (id, match_id, user_id, team_side, position, hero_id, is_win, created_at)
           VALUES ('mps1', 'm1', 'u1', 'RADIANT', 2, 74, 1, ?)""",
        (NOW,),
    )
    con.commit()
    print("最小数据集写入: ok")

    print("不变量检查:")
    failures = 0

    # 1. 最终评分必须等于 clamp(系统 + 修正)
    failures += not expect_fail(
        con, "rating_adjustments 之外篡改 effective_rating",
        """INSERT INTO player_ratings (id, user_id, system_rating, admin_adjustment, effective_rating, updated_at)
           VALUES ('r_bad', 'u3', 500, 0, 900, ?)""", (NOW,),
    )
    # 2. 同一用户重复报名同一赛事
    failures += not expect_fail(
        con, "重复报名",
        """INSERT INTO registrations (id, event_id, user_id, status,
             system_rating_snapshot, admin_adjustment_snapshot, effective_rating_snapshot, snapshot_at)
           VALUES ('reg_dup', 'e1', 'u1', 'CONFIRMED', 700, 0, 700, ?)""", (NOW,),
    )
    # 3. 同一场比赛同一玩家进入两个正选阵容
    failures += not expect_fail(
        con, "同一场比赛重复上场",
        """INSERT INTO team_members (id, team_id, match_id, user_id, team_side, assigned_position,
             system_rating_snapshot, admin_adjustment_snapshot, effective_rating_snapshot)
           VALUES ('tm_dup', 't2', 'm1', 'u1', 'DIRE', 3, 720, 50, 770)""",
    )
    # 4. 同一队伍两个 2 号位
    failures += not expect_fail(
        con, "同一队伍位置冲突",
        """INSERT INTO team_members (id, team_id, match_id, user_id, team_side, assigned_position,
             system_rating_snapshot, admin_adjustment_snapshot, effective_rating_snapshot)
           VALUES ('tm_pos', 't1', 'm1', 'u2', 'RADIANT', 2, 700, 0, 700)""",
    )
    # 5. 身份验证矩阵（0003 之后）
    failures += not expect_fail(
        con, "OpenID 路径给了非法 SteamID64",
        """INSERT INTO game_accounts (id, user_id, provider, steam_id64, dota_account_id, verification)
           VALUES ('ga_bad', 'u1', 'STEAM_OPENID', '76561198abc', 123, 'VERIFIED')""",
    )
    failures += not expect_fail(
        con, "声明路径却带着 steam_id64（伪装已验证）",
        """INSERT INTO game_accounts (id, user_id, provider, steam_id64, dota_account_id, verification)
           VALUES ('ga_fake', 'u1', 'DOTA_ACCOUNT_ID', '76561198070168584', 109902856, 'CLAIMED')""",
    )
    failures += not expect_fail(
        con, "SteamID64 与 account_id 不自洽",
        """INSERT INTO game_accounts (id, user_id, provider, steam_id64, dota_account_id, verification, verified_at)
           VALUES ('ga_mismatch', 'u1', 'STEAM_OPENID', '76561198070168584', 999, 'VERIFIED', ?)""", (NOW,),
    )
    failures += not expect_fail(
        con, "声明路径标记为 VERIFIED",
        """INSERT INTO game_accounts (id, user_id, provider, dota_account_id, verification)
           VALUES ('ga_lie', 'u1', 'DOTA_ACCOUNT_ID', 449792345, 'VERIFIED')""",
    )
    # 合法：OpenID 已验证（109902856 就是用户举的那个例子）
    try:
        con.execute(
            """INSERT INTO game_accounts (id, user_id, provider, steam_id64, dota_account_id, verification, verified_at)
               VALUES ('ga_ok', 'u1', 'STEAM_OPENID', '76561198070168584', 109902856, 'VERIFIED', ?)""",
            (NOW,),
        )
        con.commit()
        print("  [ok] 允许: OpenID 绑定（steam_id64 与 account_id 自洽）")
    except sqlite3.Error as exc:
        failures += 1
        print(f"  [FAIL] 合法 OpenID 绑定被拒: {exc}")
    # 合法：另一用户纯声明
    try:
        con.execute(
            """INSERT INTO game_accounts (id, user_id, provider, dota_account_id, verification)
               VALUES ('ga_claim', 'u2', 'DOTA_ACCOUNT_ID', 449792345, 'CLAIMED')"""
        )
        con.commit()
        print("  [ok] 允许: 只填数字 ID 的声明式绑定")
    except sqlite3.Error as exc:
        failures += 1
        print(f"  [FAIL] 声明式绑定被拒: {exc}")
    # 同一 DOTA 账号不能被第二个用户占用
    failures += not expect_fail(
        con, "冒领他人 account_id",
        """INSERT INTO game_accounts (id, user_id, provider, dota_account_id, verification)
           VALUES ('ga_dup', 'u9', 'DOTA_ACCOUNT_ID', 109902856, 'CLAIMED')""",
    )
    # 一人只能绑一个身份
    failures += not expect_fail(
        con, "同一用户绑定第二个身份",
        """INSERT INTO game_accounts (id, user_id, provider, dota_account_id, verification)
           VALUES ('ga_second', 'u2', 'DOTA_ACCOUNT_ID', 123123123, 'CLAIMED')""",
    )
    # 6. 报名状态 WAITLIST 必须有排队位
    failures += not expect_fail(
        con, "候补缺少排队位",
        """INSERT INTO registrations (id, event_id, user_id, status,
             system_rating_snapshot, admin_adjustment_snapshot, effective_rating_snapshot, snapshot_at)
           VALUES ('reg_wl', 'e1', 'u2', 'WAITLIST', 700, 0, 700, ?)""", (NOW,),
    )
    # 7. 容量不是 10 的整数倍
    failures += not expect_fail(
        con, "容量不是 10 的整数倍",
        """INSERT INTO events (id, title, capacity, created_by) VALUES ('e_bad', 'bad', 15, 'u3')""",
    )
    # 8. 已经发布但没有 published_at
    failures += not expect_fail(
        con, "PUBLISHED 缺少 published_at",
        """INSERT INTO matches (id, event_id, match_no, status, created_by)
           VALUES ('m_bad', 'e1', 9, 'PUBLISHED', 'u3')""",
    )
    # 9. 管理员修正原因为空
    failures += not expect_fail(
        con, "评分修正缺少原因",
        """INSERT INTO rating_adjustments (id, user_id, operator_id, old_adjustment, new_adjustment,
             old_effective, new_effective, reason)
           VALUES ('ra_bad', 'u1', 'u3', 0, 50, 720, 770, '   ')""",
    )
    # 10. 合法写入：候补不受位置唯一约束
    try:
        con.execute(
            """INSERT INTO team_members (id, team_id, match_id, user_id, team_side, assigned_position,
                 system_rating_snapshot, admin_adjustment_snapshot, effective_rating_snapshot,
                 is_substitute, position_fit_score)
               VALUES ('tm_sub', 't1', 'm1', 'u2', 'RADIANT', 2, 700, 0, 700, 1, 55)"""
        )
        con.commit()
        print("  [ok] 允许: 候补可以占用同一位置（is_substitute = 1）")
    except sqlite3.Error as exc:
        failures += 1
        print(f"  [FAIL] 候补被误拒: {exc}")

    # 11. 邀请码必须是大写规范形式
    failures += not expect_fail(
        con, "小写邀请码",
        "INSERT INTO invite_codes (id, code, max_uses) VALUES ('ic_bad', 'hive-lower', 1)",
    )
    # 12. 邀请码不允许超发
    failures += not expect_fail(
        con, "邀请码使用次数超过上限",
        "INSERT INTO invite_codes (id, code, max_uses, used_count) VALUES ('ic_bad2', 'HIVE-FULL', 1, 2)",
    )
    # 13. 同一邀请码不能重复
    failures += not expect_fail(
        con, "重复邀请码",
        "INSERT INTO invite_codes (id, code, max_uses) VALUES ('ic_bad3', 'HIVE-DUP', 1), ('ic_bad4', 'HIVE-DUP', 1)",
    )
    # 14. 同一去重键不能有两条在途任务
    failures += not expect_fail(
        con, "同一玩家重复入队同步任务",
        """INSERT INTO sync_jobs (id, kind, payload_json, dedupe_key, available_at)
           VALUES ('j1', 'PLAYER_SYNC', '{}', 'player:u1', ?), ('j2', 'PLAYER_SYNC', '{}', 'player:u1', ?)""",
        (NOW, NOW),
    )
    # 15. DONE / DEAD 必须带 finished_at
    failures += not expect_fail(
        con, "终态任务缺少 finished_at",
        """INSERT INTO sync_jobs (id, kind, payload_json, status, available_at)
           VALUES ('j_bad', 'PLAYER_SYNC', '{}', 'DONE', ?)""", (NOW,),
    )
    # 16. 允许：已完成的去重键可以再次入队（用户可再次手动同步）
    try:
        con.execute(
            """INSERT INTO sync_jobs (id, kind, payload_json, dedupe_key, status, available_at, finished_at)
               VALUES ('j_done', 'PLAYER_SYNC', '{}', 'player:u2', 'DONE', ?, ?)""",
            (NOW, NOW),
        )
        con.execute(
            """INSERT INTO sync_jobs (id, kind, payload_json, dedupe_key, available_at)
               VALUES ('j_new', 'PLAYER_SYNC', '{}', 'player:u2', ?)""",
            (NOW,),
        )
        con.commit()
        print("  [ok] 允许: 终态之后同一 dedupe_key 可重新入队")
    except sqlite3.Error as exc:
        failures += 1
        print(f"  [FAIL] 重新入队被误拒: {exc}")
    # 17. 允许：注册用户可携带邀请码溯源
    try:
        con.execute(
            """INSERT INTO invite_codes (id, code, max_uses) VALUES ('ic_ok', 'HIVE-OPEN', 20)"""
        )
        con.execute(
            """INSERT INTO users (id, username, display_name, email, password_hash, invite_code_id)
               VALUES ('u9', 'player_c', 'Player C', 'c@hive.test', 'x', 'ic_ok')"""
        )
        con.commit()
        print("  [ok] 允许: users 记录邀请码来源")
    except sqlite3.Error as exc:
        failures += 1
        print(f"  [FAIL] 邀请码溯源写入失败: {exc}")

    print(f"\n结果: {'全部通过' if failures == 0 else f'{failures} 项失败'}")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
