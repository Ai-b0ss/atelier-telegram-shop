"""A public demonstration bot must not accept requests from other users."""
import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

from aiogram.types import CallbackQuery, Message

from atelier.demo_guard import DemoOnlyMiddleware


def test_demo_guard_accepts_only_selected_admin():
    async def scenario():
        middleware = DemoOnlyMiddleware({777})
        handler = AsyncMock(return_value="allowed")
        admin = Mock(spec=Message)
        admin.from_user = SimpleNamespace(id=777)
        admin.answer = AsyncMock()
        assert await middleware(handler, admin, {}) == "allowed"
        handler.assert_awaited_once()
        admin.answer.assert_not_awaited()

    asyncio.run(scenario())


def test_demo_guard_denies_nonadmin_messages_and_callbacks():
    async def scenario():
        middleware = DemoOnlyMiddleware({777})
        handler = AsyncMock()
        stranger = Mock(spec=Message)
        stranger.from_user = SimpleNamespace(id=123)
        stranger.answer = AsyncMock()
        assert await middleware(handler, stranger, {}) is None
        stranger.answer.assert_awaited_once()
        handler.assert_not_awaited()

        callback = Mock(spec=CallbackQuery)
        callback.from_user = SimpleNamespace(id=123)
        callback.answer = AsyncMock()
        assert await middleware(handler, callback, {}) is None
        callback.answer.assert_awaited_once()
        assert callback.answer.await_args.kwargs["show_alert"] is True
        handler.assert_not_awaited()

    asyncio.run(scenario())
