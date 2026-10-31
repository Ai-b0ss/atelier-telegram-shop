"""Restrict the public demo bot to its configured administrator."""
from __future__ import annotations
from typing import Any, Awaitable, Callable
from aiogram import BaseMiddleware
from aiogram.types import TelegramObject, Message, CallbackQuery


class DemoOnlyMiddleware(BaseMiddleware):
    def __init__(self, allowed_user_ids: set[int]) -> None:
        self.allowed_user_ids = set(allowed_user_ids)

    async def __call__(
        self,
        handler: Callable[[TelegramObject, dict[str, Any]], Awaitable[Any]],
        event: TelegramObject,
        data: dict[str, Any],
    ) -> Any:
        user = getattr(event, "from_user", None)
        if user is not None and user.id in self.allowed_user_ids:
            return await handler(event, data)
        if isinstance(event, CallbackQuery):
            await event.answer("Демонстрация доступна только администратору.", show_alert=True)
        elif isinstance(event, Message):
            await event.answer("Магазин пока в тестовом режиме. Заказы не принимаются.")
        return None
