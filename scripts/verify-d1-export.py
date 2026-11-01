"""Validate a D1 SQL export supplied *only* on stdin; print no user data."""
import sqlite3
import sys

def main() -> None:
    from pathlib import Path
    sql = Path(sys.argv[1]).read_text(encoding="utf-8-sig") if len(sys.argv)>1 else sys.stdin.read()
    if len(sql) < 100:
        raise ValueError("Empty export")
    db = sqlite3.connect(":memory:")
    try:
        db.executescript(sql)
        integrity = db.execute("PRAGMA integrity_check").fetchone()[0]
        if integrity != "ok":
            raise ValueError("SQLite integrity check failed")
        rows = db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
        tables = {name for (name,) in rows}
        required = {"customers", "orders", "variants", "order_items", "payments", "inventory_return_receipts"}
        if not required.issubset(tables):
            raise ValueError("Missing required D1 tables")
        print("ENCRYPTED_EXPORT_SQL_RESTORE_OK")
        print("SQLITE_INTEGRITY_OK")
        print("REQUIRED_TABLES_PRESENT")
    finally:
        db.close()

if __name__ == "__main__":
    try:main()
    except Exception as exc:
        print("BACKUP_VALIDATION_FAILED",type(exc).__name__,file=sys.stderr)
        raise SystemExit(1) from None
