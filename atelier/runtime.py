"""A process-wide OS lock: exactly one Telegram long-polling worker per SQLite database."""
from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path
import os


class AlreadyRunning(RuntimeError):
    """A different process owns this runtime lock."""


@contextmanager
def exclusive_instance(path: str | Path):
    """Acquire a non-blocking OS lock. A crash releases it automatically.

    Never delete the lock path while a process is running: deleting it can
    create two independent file objects and defeat mutual exclusion.
    """
    lockfile = Path(path)
    lockfile.parent.mkdir(parents=True, exist_ok=True)
    with lockfile.open("a+b", buffering=0) as handle:
        handle.seek(0)
        if os.name == "nt":
            import msvcrt
            try:
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError as exc:
                raise AlreadyRunning(f"Another instance owns {lockfile.name}") from exc
            try:
                yield
            finally:
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as exc:
                raise AlreadyRunning(f"Another instance owns {lockfile.name}") from exc
            try:
                yield
            finally:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
