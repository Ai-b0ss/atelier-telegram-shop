"""Verified, collision-resistant on-line backups for the local atelier database."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import os
from pathlib import Path
import secrets
import sqlite3

from .backup import backup


def create_snapshot(database: str | Path, directory: str | Path) -> Path:
    src = Path(database).resolve()
    target_dir = Path(directory).resolve()
    if not src.is_file():
        raise FileNotFoundError("Source SQLite database is missing")
    if target_dir == src.parent and src.name.startswith("backup-"):
        raise ValueError("Use a separate backup directory")
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S_%fZ")
    name = f"atelier-{timestamp}-{secrets.token_hex(3)}.sqlite3"
    result = backup(src, target_dir / name)
    with sqlite3.connect(result) as db:
        check = db.execute("PRAGMA quick_check").fetchone()[0]
        if check != "ok":
            result.unlink(missing_ok=True)
            raise RuntimeError("Backup verification failed")
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Create a consistent local SQLite backup")
    parser.add_argument("--database", default=os.getenv("DATABASE_PATH", "data/atelier.sqlite3"))
    parser.add_argument("--directory", default="data/backups")
    opts = parser.parse_args()
    result = create_snapshot(opts.database, opts.directory)
    print(f"Backup created and verified: {result}")


if __name__ == "__main__":
    main()
