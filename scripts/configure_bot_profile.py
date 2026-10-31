"""Set public Telegram bot metadata without printing or committing the token."""
import asyncio
import os
from pathlib import Path
from aiogram import Bot
from aiogram.types import BotCommand
from atelier.config import load_local_env

async def main():
    load_local_env(Path(".env"))
    bot=Bot(os.environ["BOT_TOKEN"])
    demo = os.environ.get("DEMO_MODE") == "1"
    try:
        if demo:
            await bot.set_my_description(description="Демонстрационный Telegram-магазин авторской одежды. Реальные заказы пока не принимаются.")
            await bot.set_my_short_description(short_description="ДЕМО: каталог, индивидуальный пошив и тестовые заявки.")
        else:
            await bot.set_my_description(description="Магазин авторской одежды и индивидуального пошива. Каталог, оформление заказа и связь с менеджером.")
            await bot.set_my_short_description(short_description="Авторская одежда, заказ изделий и индивидуальный пошив.")
        await bot.set_my_commands([
            BotCommand(command="start",description="Каталог и услуги"),
            BotCommand(command="cancel",description="Отменить ввод"),
            BotCommand(command="privacy",description="Обработка данных"),
            BotCommand(command="forgetme",description="Удалить личные данные"),
        ])
        print("PROFILE_CONFIGURED",True,"demo_mode",demo)
    finally:
        await bot.session.close()
if __name__=="__main__":
    asyncio.run(main())
