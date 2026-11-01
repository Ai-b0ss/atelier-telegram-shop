"""Pause/resume the known Cloudflare webhook without exposing BotFather credentials."""
from __future__ import annotations
import asyncio, argparse, os, re, sys
from pathlib import Path
from aiogram import Bot

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from atelier.config import load_local_env
WEBHOOK="https://atelier-customwear-demo-2026.igorekglukhovskii43.workers.dev/webhook"
EXPECTED_USERNAME="atelier_customwear_2611_bot"

async def main(action):
    load_local_env(ROOT/".env")
    token=os.getenv("BOT_TOKEN")
    if not token: raise RuntimeError("Missing local BOT_TOKEN")
    config={}
    for line in (ROOT/".env").read_text(encoding="utf-8-sig").splitlines():
        if "=" in line:
            k,v=line.split("=",1)
            if k in {"WEBHOOK_SECRET"}:config[k]=v.strip()
    bot=Bot(token)
    try:
        me=await bot.get_me()
        if (me.username or "").lower()!=EXPECTED_USERNAME: raise RuntimeError("Unknown bot identity")
        state=await bot.get_webhook_info()
        if action=="pause":
            if state.url!=WEBHOOK:raise RuntimeError("Webhook does not match the expected URL")
            if not await bot.delete_webhook(drop_pending_updates=False):raise RuntimeError("Webhook pause refused")
            if (await bot.get_webhook_info()).url:raise RuntimeError("Webhook still active")
            print("WEBHOOK_PAUSED_PRESERVING_PENDING_UPDATES")
        elif action=="resume":
            if state.url and state.url!=WEBHOOK:raise RuntimeError("Conflicting webhook")
            secret=config.get("WEBHOOK_SECRET","")
            if not re.fullmatch(r"[A-Za-z0-9_-]{32,128}",secret):raise RuntimeError("Invalid secret")
            if not await bot.set_webhook(url=WEBHOOK,secret_token=secret,allowed_updates=["message","callback_query"],drop_pending_updates=False,max_connections=12):
                raise RuntimeError("Webhook activation refused")
            check=await bot.get_webhook_info()
            if check.url!=WEBHOOK:raise RuntimeError("Webhook verification mismatch")
            print("WEBHOOK_RESUMED")
        else:
            print("WEBHOOK_STATE", "active" if state.url==WEBHOOK else "paused" if not state.url else "unexpected")
            print("PENDING_UPDATES",state.pending_update_count)
    finally:
        await bot.session.close()
if __name__=="__main__":
    ap=argparse.ArgumentParser()
    ap.add_argument("action",choices=["pause","resume","status"])
    args=ap.parse_args()
    try:asyncio.run(main(args.action))
    except Exception as exc:
        print("WEBHOOK_MAINTENANCE_FAILED",type(exc).__name__)
        raise SystemExit(1) from None
