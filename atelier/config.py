"""Minimal, deliberately restricted loader for local Telegram deployment settings."""
from __future__ import annotations

import os
from pathlib import Path

_ALLOWED = frozenset({"BOT_TOKEN", "ADMIN_IDS", "DATABASE_PATH"})


def load_local_env(path: str | Path = ".env") -> None:
    """Load only known keys, preserving existing process environment values.

    .env is untrusted text, not shell code: never evaluate or expand it.
    Keep the file private and out of Git (see .gitignore).
    """
    file_path = Path(path)
    if not file_path.is_file():
        return
    for raw in file_path.read_text(encoding="utf-8-sig").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        name, value = name.strip(), value.strip()
        if name not in _ALLOWED:
            continue
        if len(value) >= 2 and value[0] in ("'", '"') and value[-1] == value[0]:
            value = value[1:-1]
        os.environ.setdefault(name, value)
