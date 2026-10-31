"""Offline XLSX export, without bot token or Telegram network access."""
from __future__ import annotations

import argparse
import os
from pathlib import Path

from .reports import make_report
from .store import Store


def cli(argv: list[str] | None = None) -> Path:
    parser = argparse.ArgumentParser(description="Export atelier data as an Excel workbook")
    parser.add_argument("output", type=Path, help="Path to the .xlsx report")
    parser.add_argument("--database", default=os.getenv("DATABASE_PATH", "data/atelier.sqlite3"))
    args = parser.parse_args(argv)
    if not Path(args.database).is_file():
        parser.error(f"Database not found: {args.database}")
    if args.output.suffix.lower() != ".xlsx":
        parser.error("Output must have .xlsx extension")
    if args.output.exists():
        parser.error("File already exists; choose another path to avoid overwriting reports")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    data = make_report(Store(args.database))
    # Exclusive creation keeps accidental repeated commands from overwriting a report.
    with args.output.open("xb") as output:
        output.write(data)
    print(f"Report saved: {args.output}")
    return args.output


if __name__ == "__main__":
    cli()
