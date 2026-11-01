"""Verify real Telegram webhook target and Cloudflare availability without exposing secrets."""
from __future__ import annotations
import asyncio
import json
import os
from pathlib import Path
import subprocess
import sys

from aiogram import Bot

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from atelier.config import load_local_env

URL="https://atelier-customwear-demo-2026.igorekglukhovskii43.workers.dev"

async def main():
    load_local_env(ROOT/".env")
    token=os.environ.get("BOT_TOKEN","")
    if not token:
        raise RuntimeError("Bot is not configured")
    result=subprocess.run(["curl.exe","--fail","--silent","--show-error","--max-time","20",URL+"/health"],capture_output=True,text=True,timeout=25)
    if result.returncode:
        raise RuntimeError("Worker not responding")
    health=json.loads(result.stdout)
    if not health.get("ok") or not health.get("database") or health.get("mode")!="demo":
        raise RuntimeError("Cloudflare health check did not pass")
    bot=Bot(token=token)
    try:
        info=await bot.get_webhook_info()
        if info.url!=URL+"/webhook":
            raise RuntimeError("Unexpected webhook target")
        if info.last_error_message:
            raise RuntimeError("Telegram recorded a webhook delivery error")
        print("CLOUD_WORKER_OK")
        print("TELEGRAM_WEBHOOK_ACTIVE")
        print("PENDING_UPDATES",info.pending_update_count)
    finally:
        await bot.session.close()

if __name__=="__main__":
    try: asyncio.run(main())
    except Exception as exc:
        print("CLOUD_VERIFICATION_FAILED",type(exc).__name__)
        raise SystemExit(1) from None
