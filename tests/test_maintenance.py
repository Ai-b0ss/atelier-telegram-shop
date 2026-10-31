"""A backup must be restorable and stable while the live database changes."""
import sqlite3
from pathlib import Path

import pytest

from atelier.maintenance import create_snapshot
from atelier.store import Store


def test_snapshot_can_restore_while_source_changes(tmp_path):
    source = tmp_path / "live.sqlite3"
    store = Store(source)
    store.seed_demo()
    saved = create_snapshot(source, tmp_path / "backups")
    assert saved.exists()
    first_categories = sqlite3.connect(saved).execute("SELECT count(*) FROM categories").fetchone()[0]
    assert first_categories >= 1

    with store.connection() as conn:
        conn.execute("INSERT INTO categories(name) VALUES('Later')")
    saved2 = create_snapshot(source, tmp_path / "backups")
    assert saved2 != saved
    assert sqlite3.connect(saved).execute("SELECT count(*) FROM categories").fetchone()[0] == first_categories
    assert sqlite3.connect(saved2).execute("SELECT count(*) FROM categories").fetchone()[0] == first_categories+1
    assert sqlite3.connect(saved).execute("PRAGMA integrity_check").fetchone()[0] == "ok"


def test_snapshot_does_not_create_false_backups(tmp_path):
    with pytest.raises(FileNotFoundError):
        create_snapshot(tmp_path / "not-there.sqlite3", tmp_path / "backups")
    assert not (tmp_path / "backups").exists()
