"""Offline D1 export acceptance tests: synthetic schemas only, no customer data."""
from __future__ import annotations

import importlib.util
import sqlite3
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODULE_FILE = ROOT / "scripts" / "verify-d1-export.py"
spec = importlib.util.spec_from_file_location("verify_d1_export", MODULE_FILE)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def synthetic_export():
    statements = [
        "CREATE TABLE customers(id INTEGER PRIMARY KEY);",
        "CREATE TABLE orders(id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customers(id));",
        "CREATE TABLE variants(id INTEGER PRIMARY KEY);",
        "CREATE TABLE order_items(id INTEGER PRIMARY KEY, order_id INTEGER REFERENCES orders(id));",
        "CREATE TABLE payments(id INTEGER PRIMARY KEY, order_id INTEGER REFERENCES orders(id));",
        "CREATE TABLE inventory_return_receipts(id INTEGER PRIMARY KEY);",
    ]
    for name in sorted(module.REQUIRED_TRIGGERS):
        statements.append(f"CREATE TRIGGER {name} AFTER INSERT ON orders BEGIN SELECT 1; END;")
    return "\n".join(statements)


def test_valid_synthetic_export_roundtrip():
    module.verify(synthetic_export())
    result = subprocess.run([sys.executable, str(MODULE_FILE)], input=synthetic_export(),
                            text=True, capture_output=True, timeout=10)
    assert result.returncode == 0
    assert "FOREIGN_KEYS_VALID" in result.stdout
    assert "REQUIRED_TRIGGERS_PRESENT" in result.stdout


def test_required_table_missing():
    sql = synthetic_export().replace("CREATE TABLE payments", "CREATE TABLE skipped_payments")
    try:
        module.verify(sql)
    except ValueError as exc:
        assert str(exc) == "Missing required D1 tables"
    else:
        raise AssertionError("missing table accepted")


def test_missing_inventory_trigger():
    name = "trg_atelier_cancel_restocks"
    sql = synthetic_export().replace(
        f"CREATE TRIGGER {name} AFTER INSERT ON orders BEGIN SELECT 1; END;", ""
    )
    try:
        module.verify(sql)
    except ValueError as exc:
        assert str(exc) == "Missing required inventory triggers"
    else:
        raise AssertionError("missing trigger accepted")


def test_broken_foreign_key_is_rejected():
    sql = synthetic_export() + "\nINSERT INTO orders(id, customer_id) VALUES (123, 999);"
    try:
        module.verify(sql)
    except ValueError as exc:
        assert str(exc) == "Broken foreign key references"
    else:
        raise AssertionError("broken foreign key accepted")


def test_corrupt_export_fails_without_leaking_source():
    sql = synthetic_export() + "\nTHIS IS SECRET PRIVATE DATA AND INVALID SQL;"
    result = subprocess.run([sys.executable, str(MODULE_FILE)], input=sql,
                            text=True, capture_output=True, timeout=10)
    assert result.returncode != 0
    assert "BACKUP_VALIDATION_FAILED" in result.stderr
    assert "SECRET PRIVATE" not in (result.stdout + result.stderr)


def test_attached_external_database_is_rejected(tmp_path):
    path = tmp_path / "unwanted.db"
    sql = synthetic_export() + "\nATTACH DATABASE '" + str(path).replace("'", "''") + "' AS other;"
    try:
        module.verify(sql)
    except sqlite3.DatabaseError:
        pass
    else:
        raise AssertionError("external database attachment accepted")
    assert not path.exists()


def test_real_source_schema_migrations_when_present():
    cloud = ROOT / "cloudflare"
    schema = cloud / "schema.sql"
    migrations = cloud / "migrations"
    if not schema.exists() or not migrations.exists():
        return  # Local standalone development; CI always includes the repository.
    sql = schema.read_text("utf-8")
    for migration in sorted(migrations.glob("*.sql")):
        sql += "\n" + migration.read_text("utf-8")
    module.verify(sql)
