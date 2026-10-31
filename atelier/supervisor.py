"""Supervise one local aiogram worker and take periodic SQLite snapshots.

Intended for an ordinary-user Windows scheduled task (logon, not a server).
The OS singleton lock prevents two supervisors; the bot has its own lock.
"""
from __future__ import annotations

import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import subprocess
import sys
import threading
import time

from .config import load_local_env
from .maintenance import create_snapshot
from .runtime import AlreadyRunning, exclusive_instance

BACKUP_INTERVAL_SECONDS = 6 * 3600
LOG_MAX_BYTES = 3 * 1024 * 1024


def configure_logger(log_path: Path) -> logging.Logger:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    logger = logging.getLogger("atelier.supervisor")
    logger.setLevel(logging.INFO)
    if not logger.handlers:
        handler = RotatingFileHandler(log_path, maxBytes=LOG_MAX_BYTES, backupCount=3, encoding="utf-8")
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
        logger.addHandler(handler)
    return logger


def launch_worker(python: Path, root: Path, logger: logging.Logger) -> subprocess.Popen:
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    worker = subprocess.Popen(
        [str(python), "-m", "atelier"], cwd=str(root),
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        creationflags=flags,
        env={**os.environ, "PYTHONIOENCODING": "utf-8"},
    )
    # A Windows scheduled task can terminate its Python parent but leave the
    # bot grandchild alive. This job guarantees shutdown when the parent dies.
    if os.name == "nt":
        from .windows_job import KillOnCloseJob
        try:
            worker._atelier_job = KillOnCloseJob(worker)
        except BaseException:
            worker.kill()
            worker.wait(timeout=5)
            raise

    def drain() -> None:
        assert worker.stdout is not None
        for line in iter(worker.stdout.readline, b""):
            text = line.decode("utf-8", "replace").rstrip()
            # Defensive: do not retain a token should an external traceback contain it.
            secret = os.environ.get("BOT_TOKEN", "")
            if secret:
                text = text.replace(secret, "[REDACTED]")
            if text:
                logger.info("bot: %s", text)

    threading.Thread(target=drain, name="bot-log-reader", daemon=True).start()
    return worker


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    os.chdir(root)
    load_local_env(root / ".env")
    if not os.getenv("BOT_TOKEN") or not os.getenv("ADMIN_IDS"):
        raise SystemExit("Local .env with BOT_TOKEN and ADMIN_IDS is required")
    if os.getenv("DEMO_MODE", "1") not in {"0", "1"}:
        raise SystemExit("DEMO_MODE must be 0 or 1")
    python = root / ".venv" / "Scripts" / "python.exe" if os.name == "nt" else Path(sys.executable)
    if not python.is_file():
        raise SystemExit("Project Python environment is missing")
    db = Path(os.getenv("DATABASE_PATH", "data/atelier.sqlite3")).resolve()
    logs = root / "data" / "logs"
    logger = configure_logger(logs / "supervisor.log")
    lockfile = db.with_suffix(".supervisor.lock")
    try:
        with exclusive_instance(lockfile):
            logger.info("Supervisor started (demo=%s)", os.getenv("DEMO_MODE", "1") != "0")
            child = None
            delay = 10
            last_backup = float('-inf')
            try:
                while True:
                    if db.is_file() and time.monotonic() - last_backup >= BACKUP_INTERVAL_SECONDS:
                        try:
                            saved = create_snapshot(db, root / "data" / "backups")
                            logger.info("Verified snapshot %s", saved.name)
                            last_backup = time.monotonic()
                        except Exception as exc:
                            logger.error("Backup failed: %s", type(exc).__name__)
                            # Retry after 5 minutes instead of busy-looping.
                            last_backup = time.monotonic() - BACKUP_INTERVAL_SECONDS + 300
                    if child is None:
                        child = launch_worker(python, root, logger)
                        started = time.monotonic()
                        logger.info("Bot process started pid=%d", child.pid)
                    try:
                        code = child.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        continue
                    logger.warning("Bot exited with code %d", code)
                    if hasattr(child, "_atelier_job"):
                        child._atelier_job.close()
                    child = None
                    if time.monotonic() - started >= 300:
                        delay = 10
                    else:
                        delay = min(120, delay * 2)
                    time.sleep(delay)
            finally:
                if child is not None and child.poll() is None:
                    child.terminate()
                    try:
                        child.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        child.kill()
                        child.wait(timeout=5)
                if child is not None and hasattr(child, "_atelier_job"):
                    child._atelier_job.close()
                logger.info("Supervisor stopped")
    except AlreadyRunning:
        logger.info("Another supervisor is already running. Exiting without action.")


if __name__ == "__main__":
    main()
