"""Manually restore Windows polling after Cloudflare webhook failure.

Never run while cloud is healthy unless deliberately switching back.
"""
from __future__ import annotations
import asyncio
import os
import subprocess
import sys
from pathlib import Path
from aiogram import Bot

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from atelier.config import load_local_env

async def main():
    load_local_env(ROOT/".env")
    token=os.environ.get("BOT_TOKEN","")
    if not token: raise RuntimeError("Bot token is unavailable")
    bot=Bot(token)
    try:
        result=await bot.delete_webhook(drop_pending_updates=False)
        if result is not True: raise RuntimeError("Telegram refused deleteWebhook")
        state=await bot.get_webhook_info()
        if state.url: raise RuntimeError("Webhook still active; local polling not started")
    finally:
        await bot.session.close()
    command=(
      "Enable-ScheduledTask -TaskName AtelierTelegramDemo -ErrorAction Stop | Out-Null; "
      "Start-ScheduledTask -TaskName AtelierTelegramDemo -ErrorAction Stop"
    )
    res=subprocess.run(["powershell","-NoProfile","-NonInteractive","-Command",command],
                      capture_output=True,text=True,timeout=30)
    if res.returncode: raise RuntimeError("Could not restart Windows task")
    print("CLOUD_WEBHOOK_REMOVED")
    print("WINDOWS_BOT_RESTORED")

if __name__=="__main__":
    try: asyncio.run(main())
    except Exception as exc:
        print("ROLLBACK_FAILED",type(exc).__name__)
        raise SystemExit(1) from None
