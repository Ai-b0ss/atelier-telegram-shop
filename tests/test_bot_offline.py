"""Offline handler-contract smoke tests using minimal fake aiogram interfaces.

These are NOT Telegram API tests; they exercise real handler bodies and Store
without network access. Real aiogram dispatch must still be acceptance-tested.
"""
import asyncio
import importlib.util
import sys
import types
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from atelier.store import Store


class FakeFilter:
    def __getattr__(self, _name):
        return self

    def __eq__(self, _other):
        return self

    def __or__(self, _other):
        return self

    def startswith(self, _text):
        return self


class Hook:
    def filter(self, *_args):
        return None

    def __call__(self, *_filters):
        def unchanged(fn):
            return fn
        return unchanged


class Router:
    def __init__(self):
        self.message = Hook()
        self.callback_query = Hook()


class Keyboard:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


class Button:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


class State:
    pass


class StatesGroup:
    pass


class BufferedInputFile:
    def __init__(self, data, filename):
        self.data, self.filename = data, filename


@pytest.fixture
def bot_module(monkeypatch, tmp_path):
    aiogram = types.ModuleType("aiogram")
    aiogram.Bot = object
    aiogram.Dispatcher = object
    aiogram.F = FakeFilter()
    aiogram.Router = Router
    filters = types.ModuleType("aiogram.filters")
    filters.Command = lambda *_args: object()
    filters.CommandStart = lambda: object()
    fsm = types.ModuleType("aiogram.fsm")
    fsm_context = types.ModuleType("aiogram.fsm.context")
    fsm_context.FSMContext = object
    fsm_state = types.ModuleType("aiogram.fsm.state")
    fsm_state.State, fsm_state.StatesGroup = State, StatesGroup
    types_module = types.ModuleType("aiogram.types")
    types_module.BufferedInputFile = BufferedInputFile
    types_module.CallbackQuery = object
    types_module.InlineKeyboardButton = Button
    types_module.InlineKeyboardMarkup = Keyboard
    types_module.Message = object
    for name, obj in {
        "aiogram": aiogram,
        "aiogram.filters": filters,
        "aiogram.fsm": fsm,
        "aiogram.fsm.context": fsm_context,
        "aiogram.fsm.state": fsm_state,
        "aiogram.types": types_module,
    }.items():
        monkeypatch.setitem(sys.modules, name, obj)
    spec = importlib.util.spec_from_file_location(
        "atelier.bot", Path(__file__).parents[1] / "atelier" / "bot.py"
    )
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, "atelier.bot", module)
    spec.loader.exec_module(module)
    module.DB = Store(tmp_path / "bot-test.sqlite3")
    module.DB.seed_demo()
    module.ADMINS = {777}
    return module


def fake_message(user_id, text="", *, username="u"):
    return SimpleNamespace(
        text=text,
        from_user=SimpleNamespace(id=user_id, full_name="Клиент Тест", username=username),
        answer=AsyncMock(), answer_document=AsyncMock(),
    )


def fake_call(user_id, data):
    return SimpleNamespace(
        data=data,
        from_user=SimpleNamespace(id=user_id, full_name="Клиент Тест", username="u"),
        answer=AsyncMock(),
        message=SimpleNamespace(answer=AsyncMock(), answer_photo=AsyncMock()),
    )


class FakeState:
    def __init__(self):
        self.data = {}
        self.current = None

    async def clear(self):
        self.current = None
        self.data.clear()

    async def update_data(self, **kwargs):
        self.data.update(kwargs)

    async def set_state(self, state):
        self.current = state

    async def get_data(self):
        return dict(self.data)


def test_catalog_cart_checkout_message_handlers(bot_module):
    async def scenario():
        module = bot_module
        user_id = 101
        telegram = SimpleNamespace(send_message=AsyncMock())
        state = FakeState()
        await module.start(fake_message(user_id, "/start"), state)
        categories = fake_call(user_id, "cats")
        await module.categories(categories)
        assert categories.message.answer.await_count == 1
        variant = module.DB.variants(module.DB.products(1)[0]["id"])[0]["id"]
        add = fake_call(user_id, f"add:{variant}")
        await module.add(add)
        assert add.answer.await_count == 1
        cart = fake_call(user_id, "cart")
        await module.cart(cart)
        assert "Корзина" in cart.message.answer.call_args.args[0]
        await module.begin_checkout(fake_call(user_id, "checkout"), state)
        assert state.current is module.Checkout.name
        await module.checkout_name(fake_message(user_id, "Надежда"), state)
        await module.checkout_phone(fake_message(user_id, "@contact"), state)
        done = fake_message(user_id, "Самовывоз")
        await module.checkout_done(done, state, telegram)
        assert "Заказ №" in done.answer.call_args.args[0]
        assert state.current is None
        assert module.DB.list_orders()[0]["status"] == "new"
        telegram.send_message.assert_awaited_once()
    asyncio.run(scenario())


def test_quote_buttons_authorization_reprice_and_replay(bot_module):
    async def scenario():
        module = bot_module
        cid = module.DB.customer(1234, "Вера")
        oid = module.DB.custom_order(cid, "Вера", "@vera", "Самовывоз",
                                     "Пальто ручной работы с вышивкой", "Рост 166")
        telegram = SimpleNamespace(send_message=AsyncMock())
        await module.quote_cmd(fake_message(777, f"/quote {oid} 8500 2500"), telegram)
        assert telegram.send_message.await_count == 1
        buttons = telegram.send_message.call_args.kwargs["reply_markup"].inline_keyboard
        old_approval = buttons[0][0].callback_data
        assert old_approval.startswith(f"qa:{oid}:1:")
        await module.quote_cmd(fake_message(777, f"/quote {oid} 8500 2700"), telegram)
        old = fake_call(1234, old_approval)
        await module.quote_decision(old, telegram)
        assert old.answer.call_args.kwargs.get("show_alert") is True
        assert module.DB.order(oid)["status"] == "new"
        new_button = telegram.send_message.call_args.kwargs["reply_markup"].inline_keyboard[0][0].callback_data
        unauthorized = fake_call(1235, new_button)
        await module.quote_decision(unauthorized, telegram)
        assert unauthorized.answer.call_args.kwargs.get("show_alert") is True
        assert module.DB.order(oid)["status"] == "new"
        valid = fake_call(1234, new_button)
        await module.quote_decision(valid, telegram)
        assert valid.answer.call_args.kwargs.get("show_alert") is None
        assert module.DB.order(oid)["status"] == "confirmed"
    asyncio.run(scenario())


def test_non_admin_cannot_receive_excel_or_payment_details(bot_module):
    async def scenario():
        module = bot_module
        untrusted = fake_message(9999, "/report")
        await module.report_cmd(untrusted)
        untrusted.answer.assert_awaited_once()
        untrusted.answer_document.assert_not_awaited()
        payment = fake_message(9999, "/payment 1 received 100")
        await module.payment_cmd(payment)
        assert "запрещ" in payment.answer.call_args.args[0]
        authorized = fake_message(777, "/report")
        await module.report_cmd(authorized)
        assert authorized.answer_document.await_count == 1
        document = authorized.answer_document.call_args.args[0]
        assert document.filename.endswith(".xlsx")
        assert len(document.data) > 1000
    asyncio.run(scenario())
