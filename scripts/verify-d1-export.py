"""Validate a D1 SQL export in an isolated in-memory SQLite database.

Only generic status markers are printed; SQL content and customer data are never logged.
"""
from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

REQUIRED_TABLES = frozenset({
    "customers", "orders", "variants", "order_items", "payments",
    "inventory_return_receipts",
})
REQUIRED_TRIGGERS = frozenset({
    "trg_atelier_cancel_restocks",
    "trg_atelier_status_history",
    "trg_atelier_validate_inventory_return",
    "trg_atelier_apply_inventory_return",
})


def _block_external_database_access(action, arg1, arg2, db_name, source):
    """Never allow a SQL export to attach or detach external database files."""
    if action in (sqlite3.SQLITE_ATTACH, sqlite3.SQLITE_DETACH):
        return sqlite3.SQLITE_DENY
    if action == sqlite3.SQLITE_PRAGMA and str(arg1).lower() in {
        "writable_schema", "temp_store_directory", "data_store_directory",
    }:
        return sqlite3.SQLITE_DENY
    return sqlite3.SQLITE_OK


def verify(sql: str) -> None:
    if len(sql) < 100:
        raise ValueError("Empty export")
    db = sqlite3.connect(":memory:")
    try:
        db.set_authorizer(_block_external_database_access)
        db.executescript(sql)
        if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise ValueError("SQLite integrity check failed")
        if db.execute("PRAGMA foreign_key_check").fetchone() is not None:
            raise ValueError("Broken foreign key references")
        found = db.execute(
            "SELECT type, name FROM sqlite_master WHERE type IN ('table', 'trigger')"
        ).fetchall()
        tables = {name for kind, name in found if kind == "table"}
        triggers = {name for kind, name in found if kind == "trigger"}
        if not REQUIRED_TABLES.issubset(tables):
            raise ValueError("Missing required D1 tables")
        if not REQUIRED_TRIGGERS.issubset(triggers):
            raise ValueError("Missing required inventory triggers")
    finally:
        db.close()


def main() -> None:
    sql = (Path(sys.argv[1]).read_text(encoding="utf-8-sig")
           if len(sys.argv) > 1 else sys.stdin.read())
    verify(sql)
    print("ENCRYPTED_EXPORT_SQL_RESTORE_OK")
    print("SQLITE_INTEGRITY_OK")
    print("FOREIGN_KEYS_VALID")
    print("REQUIRED_TABLES_PRESENT")
    print("REQUIRED_TRIGGERS_PRESENT")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print("BACKUP_VALIDATION_FAILED", type(exc).__name__, file=sys.stderr)
        raise SystemExit(1) from None
