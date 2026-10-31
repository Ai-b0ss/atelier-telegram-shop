"""Verify the local BotFather credentials with Telegram without printing the token."""
from pathlib import Path
import asyncio
import os
import sys

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT))

from aiogram import Bot
from atelier.config import load_local_env


async def verify() -> None:
    load_local_env(PROJECT / ".env")
    token = os.environ.get("BOT_TOKEN", "").strip()
    if not token:
        raise SystemExit("Local BOT_TOKEN is missing")
    bot = Bot(token)
    try:
        me = await bot.get_me()
        expected = "atelier_customwear_2611_bot"
        if not me.username or me.username.casefold() != expected:
            raise SystemExit("Telegram returned a different bot")
        print("BotFather API check passed for @" + expected)
    finally:
        await bot.session.close()


if __name__ == "__main__":
    asyncio.run(verify())
