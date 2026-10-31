"""Consistent SQLite backups using the native online backup API (WAL-safe)."""
from __future__ import annotations

import argparse
import os
import sqlite3
from pathlib import Path
from contextlib import closing


def backup(database: str | Path, destination: str | Path) -> Path:
    src = Path(database).resolve()
    dst = Path(destination).resolve()
    if src == dst:
        raise ValueError("Backup destination cannot be the source database")
    if not src.is_file():
        raise FileNotFoundError(f"Database does not exist: {src}")
    dst.parent.mkdir(parents=True, exist_ok=True)
    # 'x' mode prevents replacing a previous backup, even on concurrent launches.
    # The SQLite connection is then opened on the exclusively created destination.
    with dst.open("xb"):
        pass
    try:
        with closing(sqlite3.connect(src, timeout=8)) as source:
            with closing(sqlite3.connect(dst)) as target:
                source.backup(target)
                ok = target.execute("PRAGMA integrity_check").fetchone()[0]
                if ok != "ok":
                    raise RuntimeError(f"Backup integrity check failed: {ok}")
    except Exception:
        dst.unlink(missing_ok=True)
        raise
    return dst


def cli(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Create a consistent backup of atelier SQLite")
    parser.add_argument("destination", type=Path)
    parser.add_argument("--database", default=os.getenv("DATABASE_PATH", "data/atelier.sqlite3"))
    args = parser.parse_args(argv)
    try:
        print(f"Backup saved: {backup(args.database, args.destination)}")
    except (ValueError, FileNotFoundError, FileExistsError, RuntimeError) as exc:
        parser.error(str(exc))


if __name__ == "__main__":
    cli()
