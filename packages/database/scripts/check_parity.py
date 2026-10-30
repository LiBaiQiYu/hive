"""校验 Drizzle Schema 与 D1 SQL 迁移的结构一致性（表 / 列 / 索引 / 外键目标）。

DDL 是唯一真源。这个脚本防止"改了 SQL 忘了改 Drizzle"这类只会在运行时才暴露的漂移。
纯正则解析，不依赖 node_modules，可在 CI 中先行执行。

用法: python packages/database/scripts/check_parity.py
"""
from __future__ import annotations

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[3]
MIGRATIONS_DIR = ROOT / "packages" / "database" / "migrations"
SCHEMA_DIR = ROOT / "packages" / "database" / "src" / "schema"
CONSTRAINT_KEYWORDS = {"CHECK", "PRIMARY", "UNIQUE", "FOREIGN", "CONSTRAINT"}


def split_top_level(body: str) -> list[str]:
    """按括号深度为 0 的逗号切分列定义，避免把 CHECK (...) 内部的逗号当成列分隔符。"""
    parts, buf, depth, in_str = [], [], 0, False
    for ch in body:
        if in_str:
            buf.append(ch)
            if ch == "'":
                in_str = False
            continue
        if ch == "'":
            in_str = True
        elif ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        elif ch == "," and depth == 0:
            parts.append("".join(buf))
            buf = []
            continue
        buf.append(ch)
    if "".join(buf).strip():
        parts.append("".join(buf))
    return parts


STATEMENT = re.compile(
    r"CREATE TABLE (\w+) \((.*?)\n\);"
    r"|ALTER TABLE (\w+) ADD COLUMN (\w+)"
    r"|ALTER TABLE (\w+) RENAME TO (\w+)"
    r"|DROP TABLE (?:IF EXISTS )?(\w+)"
    r"|DROP INDEX (?:IF EXISTS )?(\w+)"
    r"|CREATE (?:UNIQUE )?INDEX (\w+) ON (\w+)",
    re.S,
)


def parse_sql(texts: list[str]):
    """
    按迁移顺序重放表结构变更，支持表重建：
        CREATE TABLE x_rebuilt ... / DROP TABLE x / ALTER TABLE x_rebuilt RENAME TO x
    重建是 SQLite 去掉 NOT NULL 等约束的唯一办法，必须让校验脚本认得。
    """
    tables: dict[str, list[str]] = {}
    indexes: dict[str, str] = {}  # index name -> table name

    for text in texts:
        for m in STATEMENT.finditer(text):
            if m.group(1):  # CREATE TABLE
                name, body = m.group(1), m.group(2)
                cleaned = "\n".join(
                    line for line in body.splitlines() if not line.strip().startswith("--")
                )
                cols = []
                for stmt in split_top_level(cleaned):
                    tokens = stmt.split()
                    if not tokens or tokens[0].upper() in CONSTRAINT_KEYWORDS:
                        continue
                    cols.append(tokens[0])
                tables[name] = cols
            elif m.group(3):  # ALTER TABLE ... ADD COLUMN
                tables.setdefault(m.group(3), []).append(m.group(4))
            elif m.group(5):  # ALTER TABLE ... RENAME TO
                old, new = m.group(5), m.group(6)
                tables[new] = tables.pop(old, [])
                for idx, tbl in list(indexes.items()):
                    if tbl == old:
                        indexes[idx] = new
            elif m.group(7):  # DROP TABLE
                tables.pop(m.group(7), None)
                for idx, tbl in list(indexes.items()):
                    if tbl == m.group(7):
                        del indexes[idx]
            elif m.group(8):  # DROP INDEX
                indexes.pop(m.group(8), None)
            elif m.group(9):  # CREATE [UNIQUE] INDEX
                indexes[m.group(9)] = m.group(10)

    return tables, set(indexes)


def parse_drizzle(files):
    tables: dict[str, list[str]] = {}
    indexes: set[str] = set()
    exported: set[str] = set()
    refs: list[str] = []
    for path in files:
        text = path.read_text(encoding="utf-8")
        exported |= set(re.findall(r"export const (\w+) = sqliteTable\(", text))
        refs += re.findall(r"references\(\(\) => (\w+)\.", text)
        for m in re.finditer(r"sqliteTable\(\s*'(\w+)',\s*\{(.*?)\n  \},", text, re.S):
            tname, body = m.group(1), m.group(2)
            cols = re.findall(
                r"^    \w+: (?:text|integer|real)\(\s*'(\w+)'", body, re.M
            )
            tables[tname] = cols
        indexes |= set(re.findall(r"(?:uniqueIndex|index)\('([\w]+)'\)", text))
    return tables, indexes, exported, refs


def main() -> int:
    sql_tables, sql_indexes = parse_sql(
        [p.read_text(encoding="utf-8") for p in sorted(MIGRATIONS_DIR.glob("*.sql"))]
    )
    files = sorted(p for p in SCHEMA_DIR.glob("*.ts") if p.name != "index.ts")
    drz_tables, drz_indexes, exported, refs = parse_drizzle(files)

    problems: list[str] = []

    missing = sorted(set(sql_tables) - set(drz_tables))
    extra = sorted(set(drz_tables) - set(sql_tables))
    if missing:
        problems.append(f"Drizzle 缺少表: {missing}")
    if extra:
        problems.append(f"Drizzle 多出表（SQL 中不存在）: {extra}")

    for table in sorted(set(sql_tables) & set(drz_tables)):
        a, b = sql_tables[table], drz_tables[table]
        if a != b:
            only_sql = [c for c in a if c not in b]
            only_drz = [c for c in b if c not in a]
            if only_sql or only_drz:
                problems.append(
                    f"{table}: 列不一致 SQL独有={only_sql} Drizzle独有={only_drz}"
                )
            else:
                problems.append(f"{table}: 列顺序不一致\n    SQL={a}\n    DRZ={b}")

    if sql_indexes != drz_indexes:
        problems.append(
            f"索引不一致 SQL独有={sorted(sql_indexes - drz_indexes)} "
            f"Drizzle独有={sorted(drz_indexes - sql_indexes)}"
        )

    unknown = sorted({r for r in refs if r not in exported})
    if unknown:
        problems.append(f"外键引用了未导出的表常量: {unknown}")

    total_cols = sum(len(c) for c in sql_tables.values())
    print(f"SQL:      {len(sql_tables)} 表 / {total_cols} 列 / {len(sql_indexes)} 索引")
    print(f"Drizzle:  {len(drz_tables)} 表 / {sum(len(c) for c in drz_tables.values())} 列 / {len(drz_indexes)} 索引")

    if problems:
        print("\n不一致:")
        for p in problems:
            print(f"  - {p}")
        return 1
    print("\n一致性检查: 通过（表、列、列顺序、索引、外键目标全部对齐）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
