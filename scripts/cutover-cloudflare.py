"""Switch Telegram from local polling to Cloudflare webhook with automatic rollback.

Uses the Bot API through aiogram; credentials stay in local process memory.
No token appears in commands, console output, or a public repository.
"""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

from aiogram import Bot

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from atelier.config import load_local_env
WORKER_URL = "https://atelier-customwear-demo-2026.igorekglukhovskii43.workers.dev"
TASK_NAME = "AtelierTelegramDemo"


def scheduled(action: str) -> None:
    if action not in {"Start", "Stop"}:
        raise ValueError("Unsupported task action")
    result = subprocess.run(
        ["powershell", "-NoProfile", "-NonInteractive", "-Command",
         f"{action}-ScheduledTask -TaskName {TASK_NAME} -ErrorAction Stop"],
        capture_output=True, text=True, timeout=30,
    )
    if result.returncode:
        raise RuntimeError("Unable to " + action.lower() + " the local task")


def healthy() -> bool:
    response = subprocess.run(
        ["curl.exe", "--silent", "--show-error", "--fail", "--max-time", "20",
         WORKER_URL + "/health"],
        capture_output=True, text=True, timeout=25,
    )
    if response.returncode:
        return False
    try:
        result = json.loads(response.stdout)
        return (
            result.get("ok") is True and result.get("database") is True
            and result.get("mode") == "demo"
        )
    except (json.JSONDecodeError, AttributeError):
        return False


async def switch() -> None:
    os.chdir(ROOT)
    load_local_env(ROOT / ".env")
    token = os.getenv("BOT_TOKEN", "")
    if not token:
        raise RuntimeError("Local BOT_TOKEN is absent")
    secret = ""
    for line in (ROOT / ".env").read_text(encoding="utf-8-sig").splitlines():
        if line.startswith("WEBHOOK_SECRET="):
            secret = line.partition("=")[2].strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{32,128}", secret):
        raise RuntimeError("Invalid or missing local webhook secret")
    if not healthy():
        raise RuntimeError("Cloudflare health check failed; local bot unchanged")

    bot = Bot(token=token)
    stopped = False
    try:
        me = await bot.get_me()
        if (me.username or "").lower() != "atelier_customwear_2611_bot":
            raise RuntimeError("Unexpected bot identity; local bot unchanged")
        previous = await bot.get_webhook_info()
        if previous.url and previous.url != WORKER_URL + "/webhook":
            raise RuntimeError("Unknown existing webhook; refusing to replace")
        scheduled("Stop")
        stopped = True
        time.sleep(2)
        try:
            ok = await bot.set_webhook(
                url=WORKER_URL + "/webhook",
                secret_token=secret,
                allowed_updates=["message", "callback_query"],
                drop_pending_updates=False,
                max_connections=12,
            )
            if ok is not True:
                raise RuntimeError("Telegram did not accept webhook")
            state = await bot.get_webhook_info()
            if state.url != WORKER_URL + "/webhook":
                raise RuntimeError("Telegram webhook URL mismatch")
        except BaseException:
            try:
                await bot.delete_webhook(drop_pending_updates=False)
            finally:
                scheduled("Start")
            raise
        print("CLOUD_WEBHOOK_ACTIVE")
        print("LOCAL_POLLING_STOPPED")
        print("TELEGRAM_WEBHOOK_URL_VERIFIED")
    finally:
        await bot.session.close()


if __name__ == "__main__":
    try:
        asyncio.run(switch())
    except Exception as exc:
        print("CLOUD_CUTOVER_FAILED", type(exc).__name__)
        raise SystemExit(1) from None
