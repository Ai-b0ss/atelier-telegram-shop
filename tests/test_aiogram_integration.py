"""Exercise real aiogram 3 routing without a Telegram token or network access."""
import asyncio
from datetime import datetime, timezone
from unittest.mock import AsyncMock
import importlib

from aiogram import Bot, Dispatcher
from aiogram.methods import AnswerCallbackQuery, SendDocument, SendMessage, SendPhoto
from aiogram.types import CallbackQuery, Chat, Message, Update, User

from atelier.store import Store


def test_real_aiogram_catalog_checkout_and_admin_routing(tmp_path, monkeypatch):
    module = importlib.import_module("atelier.bot")
    store = Store(tmp_path / "aiogram-integration.sqlite3")
    store.seed_demo()
    monkeypatch.setattr(module, "DB", store, raising=False)
    monkeypatch.setattr(module, "ADMINS", {777}, raising=False)

    async def scenario():
        bot = Bot(token="123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop")
        calls = []
        msg_id = 0
        update_id = 0

        async def fake_api(_bot, method, timeout=None):
            calls.append(method)
            if isinstance(method, AnswerCallbackQuery):
                return True
            if isinstance(method, (SendMessage, SendPhoto, SendDocument)):
                return Message(
                    message_id=len(calls) + 1000,
                    date=datetime.now(timezone.utc),
                    chat=Chat(id=777, type="private"),
                    text=getattr(method, "text", None),
                )
            raise AssertionError(f"Unexpected Telegram API call: {type(method).__name__}")

        bot.session.make_request = AsyncMock(side_effect=fake_api)
        dp = Dispatcher()
        dp.include_router(module.router)

        def tg_user(user_id):
            return User(id=user_id, is_bot=False, first_name="Test", username=f"u{user_id}")

        async def incoming(text, user_id=100):
            nonlocal msg_id, update_id
            msg_id += 1
            update_id += 1
            payload = Message(
                message_id=msg_id, date=datetime.now(timezone.utc),
                from_user=tg_user(user_id),
                chat=Chat(id=user_id, type="private"), text=text,
            )
            return await dp.feed_update(bot, Update(update_id=update_id, message=payload))

        async def click(data, user_id=100):
            nonlocal msg_id, update_id
            msg_id += 1
            update_id += 1
            payload = Message(
                message_id=msg_id, date=datetime.now(timezone.utc),
                from_user=tg_user(user_id),
                chat=Chat(id=user_id, type="private"), text="choose",
            )
            cb = CallbackQuery(
                id=str(update_id), from_user=tg_user(user_id), chat_instance="test",
                message=payload, data=data,
            )
            return await dp.feed_update(bot, Update(update_id=update_id, callback_query=cb))

        try:
            await incoming("/start")
            assert any(isinstance(x, SendMessage) and "Ателье" in x.text for x in calls)
            await click("cats")
            category_id = store.categories()[0]["id"]
            await click(f"cat:{category_id}")
            product_id = store.products(category_id)[0]["id"]
            variant_id = store.variants(product_id)[0]["id"]
            await click(f"p:{product_id}")
            await click(f"add:{variant_id}")
            await click("cart")
            await click("checkout")
            await incoming("Анна")
            await incoming("@anna")
            await incoming("самовывоз")
            orders = store.list_orders()
            assert len(orders) == 1
            assert orders[0]["status"] == "new"

            calls.clear()
            await incoming("/orders", user_id=100)
            assert any(isinstance(x, SendMessage) and "запрещ" in x.text for x in calls)
            calls.clear()
            await incoming("/orders", user_id=777)
            assert any(isinstance(x, SendMessage) and "Заказы" in x.text for x in calls)
            calls.clear()
            await incoming("/report", user_id=777)
            assert any(isinstance(x, SendDocument) for x in calls)
            # Real FSM dispatch for individual tailoring and versioned quote approval.
            calls.clear()
            await click("custom")
            await incoming("Длинное пальто ручной работы")
            await incoming("Рост 172, талия 70")
            await incoming("Татьяна")
            await incoming("@tailor_customer")
            await incoming("Самовывоз")
            custom_orders = [order for order in store.list_orders() if order["kind"] == "custom"]
            assert len(custom_orders) == 1
            custom_id = custom_orders[0]["id"]
            calls.clear()
            await incoming(f"/quote {custom_id} 8500 3900", user_id=777)
            quote_msgs = [x for x in calls if isinstance(x, SendMessage) and x.reply_markup]
            assert quote_msgs
            old_btn = quote_msgs[-1].reply_markup.inline_keyboard[0][0].callback_data
            assert old_btn.startswith(f"qa:{custom_id}:")
            calls.clear()
            await incoming(f"/quote {custom_id} 8500 4100", user_id=777)
            quote_msgs = [x for x in calls if isinstance(x, SendMessage) and x.reply_markup]
            new_btn = quote_msgs[-1].reply_markup.inline_keyboard[0][0].callback_data
            assert old_btn != new_btn
            await click(old_btn)
            assert store.order(custom_id)["status"] == "new"
            await click(new_btn)
            assert store.order(custom_id)["status"] == "confirmed"

            # The real aiogram private-chat filter must reject group updates.
            calls.clear()
            msg_id += 1
            update_id += 1
            group_message = Message(
                message_id=msg_id, date=datetime.now(timezone.utc),
                from_user=tg_user(100),
                chat=Chat(id=-100100, type="supergroup", title="Test group"), text="/start",
            )
            await dp.feed_update(bot, Update(update_id=update_id, message=group_message))
            assert not calls, "private-only bot must not answer in groups"
        finally:
            await bot.session.close()

    asyncio.run(scenario())
