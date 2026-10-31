"""Telegram interface (aiogram 3). The business logic lives in Store."""
from __future__ import annotations

import asyncio
import html
import logging
import os
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation

from aiogram import Bot, Dispatcher, F, Router
from aiogram.filters import Command, CommandStart
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.types import (BufferedInputFile, CallbackQuery, InlineKeyboardButton,
                           InlineKeyboardMarkup, Message)

from .config import load_local_env
from .reports import make_report
from .store import STATUSES, Store, StoreError

log = logging.getLogger(__name__)
router = Router()
# Client contact details must never be requested in a group chat.
router.message.filter(F.chat.type == "private")
router.callback_query.filter(F.message.chat.type == "private")
DB: Store
ADMINS: set[int]


class Checkout(StatesGroup):
    name=State()
    phone=State()
    address=State()


class Custom(StatesGroup):
    details=State()
    measures=State()
    name=State()
    phone=State()
    address=State()


def markup(*rows: tuple[str,str]) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text=label, callback_data=data)] for label,data in rows
    ])


def rub(kopecks: int) -> str:
    return f"{kopecks / 100:,.2f}".replace(",", " ")+" ₽"


def money_to_cents(s: str) -> int:
    try:
        d=Decimal(s.replace(",","."))
        if not d.is_finite() or d<0 or d.as_tuple().exponent < -2:
            raise ValueError
        val=d*100
        if val > 10_000_000_000 or val != val.to_integral_value():
            raise ValueError
        return int(val)
    except (InvalidOperation, ValueError):
        raise StoreError("Сумма должна быть числом с точностью до копеек, например 1250.50") from None


def identity(message: Message) -> int:
    if not message.from_user:
        raise StoreError("Неизвестный пользователь")
    return DB.customer(message.from_user.id, message.from_user.full_name, message.from_user.username or "")


def is_admin(message: Message) -> bool:
    return bool(message.from_user and message.from_user.id in ADMINS)


async def notify_admins(bot: Bot, order_id: int) -> None:
    order=DB.order(order_id)
    if not order:
        return
    body=f"Новый заказ №{order_id} ({order['kind']})\nСумма: {rub(order['total_cents'])}\n/admin — управление заказами"
    for admin in ADMINS:
        try:
            await bot.send_message(admin,body)
        except Exception as exc:
            log.warning("Unable to notify admin %s: %s", admin, type(exc).__name__)


@router.message(CommandStart())
async def start(message: Message, state: FSMContext):
    await state.clear()
    identity(message)
    await message.answer("Ателье авторской одежды. Выберите действие:",
                         reply_markup=markup(("Каталог", "cats"),("Корзина", "cart"),
                                             ("Индивидуальный пошив", "custom"),("Мои заказы", "mine")))


@router.message(Command("cancel"))
async def cancel(message: Message,state: FSMContext):
    await state.clear()
    await message.answer("Ввод отменён. /start — главное меню.")


@router.message(Command("privacy"))
async def privacy_info(message: Message):
    await message.answer(
        "Бот хранит Telegram ID, контакты, сведения о заказах и мерках в локальной базе. "
        "Они доступны только администратору магазина. Финансовые операции учитываются вручную.\n"
        "/forgetme — запросить удаление персональных сведений. "
        "Уже закрытые заказы сохранят обезличенные финансовые суммы. "
        "При незавершённых заказах свяжитесь с менеджером."
    )


@router.message(Command("forgetme"))
async def forgetme(message: Message):
    await message.answer(
        "Удалить контакты, мерки и связи с историей закрытых заказов? "
        "Это действие необратимо; суммы транзакций останутся обезличенными.",
        reply_markup=markup(("Да, удалить мои данные", "privacy:delete"),
                            ("Нет, оставить", "privacy:cancel"))
    )


@router.callback_query(F.data == "privacy:cancel")
async def privacy_cancel(call: CallbackQuery):
    await call.answer("Удаление отменено")
    await call.message.answer("Данные оставлены без изменений.")


@router.callback_query(F.data == "privacy:delete")
async def privacy_delete(call: CallbackQuery, state: FSMContext):
    try:
        deleted = DB.anonymize_customer(call.from_user.id)
    except StoreError as exc:
        return await call.answer(str(exc)[:190], show_alert=True)
    await state.clear()
    await call.answer("Запрос выполнен")
    await call.message.answer("Персональные данные удалены." if deleted else "Данных для удаления не было.")


@router.callback_query(F.data == "cats")
async def categories(call: CallbackQuery):
    await call.answer()
    cats=DB.categories()
    rows=[(f"{c['name']} ({c['items']})",f"cat:{c['id']}") for c in cats if c["items"]]
    rows.append(("Главное меню","home"))
    await call.message.answer("Категории:",reply_markup=markup(*rows))


@router.callback_query(F.data == "home")
async def home(call: CallbackQuery,state: FSMContext):
    await call.answer()
    await state.clear()
    await call.message.answer("Выберите действие:",reply_markup=markup(
        ("Каталог","cats"),("Корзина","cart"),("Индивидуальный пошив","custom"),("Мои заказы","mine")))


@router.callback_query(F.data.startswith("cat:"))
async def category(call: CallbackQuery):
    await call.answer()
    try: cat_id=int(call.data.split(":")[1])
    except (ValueError,IndexError): return
    products=DB.products(cat_id)
    rows=[(f"{p['name']} — от {rub(p['min_price'])}",f"p:{p['id']}") for p in products]
    rows.append(("Назад к категориям","cats"))
    await call.message.answer("Ассортимент:" if products else "Пока нет изделий.",reply_markup=markup(*rows))


@router.callback_query(F.data.startswith("p:"))
async def product(call: CallbackQuery):
    await call.answer()
    try: pid=int(call.data.split(":")[1])
    except (ValueError,IndexError): return
    p=DB.product(pid)
    if not p:
        await call.message.answer("Изделие снято с продажи.")
        return
    variants=DB.variants(pid)
    caption=f"<b>{html.escape(p['name'])}</b>\n{html.escape(p['description'])}\nВыберите размер и цвет:"
    rows=[(f"{v['size']}, {v['color']} — {rub(v['price_cents'])} ({v['stock']} шт.)",f"add:{v['id']}") for v in variants]
    rows.append(("Категории","cats"))
    if p["photo_file_id"]:
        try:
            await call.message.answer_photo(photo=p["photo_file_id"],caption=caption,parse_mode="HTML",reply_markup=markup(*rows))
            return
        except Exception as exc:
            log.warning("Product image unavailable: %s",type(exc).__name__)
    await call.message.answer(caption,parse_mode="HTML",reply_markup=markup(*rows))


@router.callback_query(F.data.startswith("add:"))
async def add(call: CallbackQuery):
    try:
        vid=int(call.data.split(":")[1])
        user=call.from_user
        cid=DB.customer(user.id,user.full_name,user.username or "")
        DB.add_to_cart(cid,vid)
        await call.answer("Добавлено в корзину")
    except (ValueError,IndexError,StoreError) as exc:
        await call.answer(str(exc),show_alert=True)
        return
    await call.message.answer("Изделие добавлено.",reply_markup=markup(("Открыть корзину","cart"),("Продолжить покупки","cats")))


@router.callback_query(F.data == "cart")
async def cart(call: CallbackQuery):
    await call.answer()
    cid=DB.customer(call.from_user.id,call.from_user.full_name,call.from_user.username or "")
    items=DB.cart(cid)
    if not items:
        await call.message.answer("Корзина пуста.",reply_markup=markup(("Каталог","cats")))
        return
    lines=[f"{html.escape(r['name'])} ({html.escape(r['size'])}, {html.escape(r['color'])}) × {r['quantity']} — {rub(r['price_cents']*r['quantity'])}" for r in items]
    total=sum(r["price_cents"]*r["quantity"] for r in items)
    rows=[(f"Удалить {r['name']} ({r['size']})",f"rm:{r['variant_id']}") for r in items]
    rows += [("Оформить заказ","checkout"),("Каталог","cats")]
    await call.message.answer("<b>Корзина</b>\n"+"\n".join(lines)+f"\n\nИтого: <b>{rub(total)}</b>",
                              parse_mode="HTML",reply_markup=markup(*rows))


@router.callback_query(F.data.startswith("rm:"))
async def remove(call: CallbackQuery):
    try: vid=int(call.data.split(":")[1])
    except (ValueError,IndexError): return await call.answer("Ошибка кнопки",show_alert=True)
    cid=DB.customer(call.from_user.id,call.from_user.full_name,call.from_user.username or "")
    DB.remove_from_cart(cid,vid)
    await call.answer("Удалено")
    cid=DB.customer(call.from_user.id,call.from_user.full_name,call.from_user.username or "")
    # The old message is historical; send a refreshed cart via a callback-free helper.
    items=DB.cart(cid)
    if not items:
        await call.message.answer("Корзина пуста.",reply_markup=markup(("Каталог","cats")))
    else:
        await call.message.answer("Товар удалён. Откройте обновлённую корзину.",
                                  reply_markup=markup(("Корзина","cart")))


@router.callback_query(F.data == "checkout")
async def begin_checkout(call: CallbackQuery,state: FSMContext):
    await call.answer()
    cid=DB.customer(call.from_user.id,call.from_user.full_name,call.from_user.username or "")
    if not DB.cart(cid):
        return await call.message.answer("Корзина пуста.")
    await state.set_state(Checkout.name)
    await call.message.answer("Как к вам обращаться? /cancel — отменить ввод")


@router.message(Checkout.name,F.text)
async def checkout_name(message: Message,state: FSMContext):
    await state.update_data(name=message.text.strip())
    await state.set_state(Checkout.phone)
    await message.answer("Укажите телефон или другой контакт:")


@router.message(Checkout.phone,F.text)
async def checkout_phone(message: Message,state: FSMContext):
    await state.update_data(phone=message.text.strip())
    await state.set_state(Checkout.address)
    await message.answer("Укажите адрес доставки или напишите «самовывоз»:")


@router.message(Checkout.address,F.text)
async def checkout_done(message: Message,state: FSMContext,bot: Bot):
    data=await state.get_data()
    try:
        order_id=DB.checkout(identity(message),data.get("name",""),data.get("phone",""),message.text)
    except StoreError as exc:
        return await message.answer(f"Заказ не оформлен: {exc}. Уточните адрес или /cancel.")
    await state.clear()
    await message.answer(f"Заказ №{order_id} создан. Ожидайте подтверждения менеджера. Оплата пока не проведена.")
    await notify_admins(bot,order_id)


@router.callback_query(F.data == "custom")
async def begin_custom(call: CallbackQuery,state: FSMContext):
    await call.answer()
    await state.set_state(Custom.details)
    await call.message.answer("Опишите изделие, материал, фасон, цвет и пожелания (от 10 символов). /cancel — отмена")


@router.message(Custom.details,F.text)
async def custom_details(message: Message,state: FSMContext):
    if not 10 <= len(message.text.strip()) <= 3000:
        return await message.answer("Нужно описание от 10 до 3000 символов.")
    await state.update_data(details=message.text.strip())
    await state.set_state(Custom.measures)
    await message.answer("Укажите мерки, если знаете, или напишите «нужна консультация»:")


@router.message(Custom.measures,F.text)
async def custom_measures(message: Message,state: FSMContext):
    await state.update_data(measures=message.text.strip())
    await state.set_state(Custom.name)
    await message.answer("Ваше имя:")


@router.message(Custom.name,F.text)
async def custom_name(message: Message,state: FSMContext):
    await state.update_data(name=message.text.strip())
    await state.set_state(Custom.phone)
    await message.answer("Контактный телефон или Telegram для связи:")


@router.message(Custom.phone,F.text)
async def custom_phone(message: Message,state: FSMContext):
    await state.update_data(phone=message.text.strip())
    await state.set_state(Custom.address)
    await message.answer("Город и способ получения (самовывоз/доставка):")


@router.message(Custom.address,F.text)
async def custom_done(message: Message,state: FSMContext,bot: Bot):
    data=await state.get_data()
    try:
        oid=DB.custom_order(identity(message),data.get("name",""),data.get("phone",""),message.text,
                            data.get("details",""),data.get("measures",""))
    except StoreError as exc:
        return await message.answer(f"Не удалось создать заявку: {exc}")
    await state.clear()
    await message.answer(f"Заявка на индивидуальный пошив №{oid} получена. Стоимость и сроки согласует менеджер.")
    await notify_admins(bot,oid)


@router.callback_query(F.data == "mine")
async def mine(call: CallbackQuery):
    await call.answer()
    cid=DB.customer(call.from_user.id,call.from_user.full_name,call.from_user.username or "")
    orders=DB.customer_orders(cid)
    if not orders:
        return await call.message.answer("Заказов ещё нет.")
    lines=[f"№{o['id']} · {o['kind']} · {o['status']} · {rub(o['total_cents']) if o['total_cents'] else 'цена согласуется'}" for o in orders]
    await call.message.answer("Ваши заказы:\n"+"\n".join(lines))


@router.message(Command("admin"))
async def admin(message: Message):
    if not is_admin(message):
        return await message.answer("Доступ запрещён.")
    await message.answer("Управление:\n/orders [status] — список\n/status ID status — сменить статус\n"
                         "/order ID — данные заказа\n/quote ID цена себестоимость — смета индивидуального заказа\n"
                         "/payment ID received|refunded сумма [номер операции] — ручной учёт\n"
                         "/report — Excel-отчёт\n/stats — финансовая сводка\nСтатусы: "+", ".join(STATUSES))


STATUS_RU = {
    "new": "Новый", "confirmed": "Подтверждён", "in_production": "В работе",
    "ready": "Готов", "shipped": "Отправлен", "completed": "Завершён",
    "canceled": "Отменён",
}


def admin_filters() -> InlineKeyboardMarkup:
    return markup(("Все заказы", "adm:filter:all"),
                  *((label, f"adm:filter:{status}") for status, label in STATUS_RU.items()))


def orders_text(rows: list) -> str:
    if not rows:
        return "Заказов с таким статусом нет."
    lines = [f"№{o['id']} · {STATUS_RU[o['status']]} · {o['kind']} · "
             f"{rub(o['total_cents'])} · /order {o['id']}" for o in rows]
    text = "Заказы (до 30 последних):\n" + "\n".join(lines)
    return text[:3900]


@router.message(Command("orders"))
async def orders_cmd(message: Message):
    if not is_admin(message):
        return await message.answer("Доступ запрещён.")
    args = (message.text or "").split()
    try:
        rows = DB.list_orders(args[1] if len(args) > 1 else None)
    except StoreError as exc:
        return await message.answer(str(exc))
    await message.answer(orders_text(rows), reply_markup=admin_filters())


@router.callback_query(F.data.startswith("adm:filter:"))
async def admin_filter_callback(call: CallbackQuery):
    if call.from_user.id not in ADMINS:
        return await call.answer("Доступ запрещён", show_alert=True)
    status = (call.data or "").removeprefix("adm:filter:")
    if status != "all" and status not in STATUSES:
        return await call.answer("Неизвестный статус", show_alert=True)
    await call.answer()
    await call.message.answer(orders_text(DB.list_orders(None if status == "all" else status)),
                              reply_markup=admin_filters())


@router.message(Command("order"))
async def order_details(message: Message):
    if not is_admin(message): return await message.answer("Доступ запрещён.")
    parts=(message.text or "").split()
    if len(parts)!=2 or not parts[1].isdigit():
        return await message.answer("Пример: /order 12")
    o=DB.order(int(parts[1]))
    if not o: return await message.answer("Заказ не найден.")
    text=(f"Заказ №{o['id']}\nСтатус: {o['status']}\nТип: {o['kind']}\n"
          f"Цена: {rub(o['total_cents'])}\nСебестоимость: {rub(o['cost_cents'])}\n"
          f"Клиент: {o['contact_name']}\nКонтакт: {o['contact_phone']}\n"
          f"Получение: {o['delivery_address']}\nПожелания: {o['custom_details']}\n"
          f"Мерки: {o['custom_measurements']}")
    from .store import TRANSITIONS
    available = sorted(TRANSITIONS[o["status"]])
    keyboard = markup(*[(f"→ {STATUS_RU[s]}", f"adm:status:{o['id']}:{s}") for s in available]) if available else None
    await message.answer(text[:3900], reply_markup=keyboard)


@router.callback_query(F.data.startswith("adm:status:"))
async def admin_change_status(call: CallbackQuery, bot: Bot):
    if call.from_user.id not in ADMINS:
        return await call.answer("Доступ запрещён", show_alert=True)
    try:
        _, _, oid, status = (call.data or "").split(":", 3)
        order_id = int(oid)
        DB.set_status(order_id, status)
    except (ValueError, StoreError) as exc:
        return await call.answer(f"Не удалось: {exc}"[:190], show_alert=True)
    await call.answer("Статус изменён")
    await call.message.answer(f"Заказ №{order_id}: {STATUS_RU[status]}")
    order = DB.order(order_id)
    if order:
        try:
            await bot.send_message(order["telegram_id"],
                                   f"Статус заказа №{order_id}: {STATUS_RU[status]}")
        except Exception:
            log.info("Customer notification unavailable for order %s", order_id)


@router.message(Command("status"))
async def status_cmd(message: Message,bot: Bot):
    if not is_admin(message): return await message.answer("Доступ запрещён.")
    parts=(message.text or "").split()
    if len(parts)!=3: return await message.answer("Пример: /status 12 confirmed")
    try:
        oid=int(parts[1]); DB.set_status(oid,parts[2])
    except (ValueError,StoreError) as exc:
        return await message.answer(f"Не удалось изменить статус: {exc}")
    await message.answer(f"Заказ №{oid}: {parts[2]}")
    order=DB.order(oid)
    if order:
        try: await bot.send_message(order["telegram_id"],f"Статус заказа №{oid}: {parts[2]}")
        except Exception: log.info("Customer notification unavailable for order %s",oid)


@router.message(Command("stats"))
async def stats_cmd(message: Message):
    if not is_admin(message):
        return await message.answer("Доступ запрещён.")
    totals = DB.analytics()
    await message.answer(
        "Финансовая сводка (ручной учёт):\n"
        f"Поступления за вычетом возвратов: {rub(totals['net_receipts_cents'])}\n"
        f"Завершённые заказы (стоимость): {rub(totals['completed_revenue_cents'])}\n"
        f"Себестоимость завершённых: {rub(totals['completed_cost_cents'])}\n"
        f"Валовая маржа завершённых: {rub(totals['completed_gross_margin_cents'])}\n"
        f"Всего заказов: {totals['order_count']}\n"
        "Без накладных расходов и налогов. Это не бухгалтерская прибыль."
    )


@router.message(Command("quote"))
async def quote_cmd(message: Message,bot: Bot):
    if not is_admin(message): return await message.answer("Доступ запрещён.")
    parts=(message.text or "").split()
    if len(parts)!=4: return await message.answer("Пример: /quote 12 15000 8000")
    try:
        oid=int(parts[1]); price=money_to_cents(parts[2]); cost=money_to_cents(parts[3]);
        revision=DB.set_custom_price(oid,price,cost)
    except (ValueError,StoreError) as exc:
        return await message.answer(f"Ошибка сметы: {exc}")
    await message.answer(f"Смета №{oid}: {rub(price)}, себестоимость {rub(cost)}")
    order=DB.order(oid)
    if order:
        try:
            await bot.send_message(order["telegram_id"],
                f"Предложение по индивидуальному заказу №{oid}: {rub(price)}. "
                "Проверьте цену перед подтверждением. Сроки и детали уточняются у менеджера.",
                reply_markup=markup(("Согласен с ценой",f"qa:{oid}:{revision}:{price}"),
                                    ("Не согласен — отменить заявку",f"qr:{oid}:{revision}:{price}")))
        except Exception as exc:
            log.warning("Quote not delivered to customer %s: %s",oid,type(exc).__name__)
            await message.answer("Не удалось доставить предложение клиенту в Telegram; свяжитесь вручную.")


@router.callback_query(F.data.startswith("qa:") | F.data.startswith("qr:"))
async def quote_decision(call: CallbackQuery,bot: Bot):
    try:
        action,oid_s,revision_s,price_s=(call.data or "").split(":")
        if action not in ("qa","qr"):
            raise ValueError
        oid,revision,quoted_price=int(oid_s),int(revision_s),int(price_s)
        status=DB.decide_custom_quote(oid,call.from_user.id,revision,quoted_price,
                                      accept=(action=="qa"))
    except (ValueError,StoreError) as exc:
        return await call.answer(f"Предложение устарело или недоступно: {exc}"[:190],show_alert=True)
    await call.answer("Ответ сохранён")
    await call.message.answer(f"Ваш ответ по заявке №{oid} принят: {STATUS_RU[status]}.")
    for admin in ADMINS:
        try: await bot.send_message(admin,f"Ответ клиента по заявке №{oid}: {status}")
        except Exception: log.info("Unable to notify admin about quote response")


@router.message(Command("payment"))
async def payment_cmd(message: Message):
    if not is_admin(message): return await message.answer("Доступ запрещён.")
    parts=(message.text or "").split()
    if len(parts) not in (4,5):
        return await message.answer("Пример: /payment 12 received 1500 TXN-2026-001 "
                                    "(уникальный номер операции необязателен, но рекомендуется)")
    try:
        oid=int(parts[1]); amount=money_to_cents(parts[3]);
        pid=DB.record_payment(oid,parts[2],amount,reference=parts[4] if len(parts)==5 else "")
    except (ValueError,StoreError) as exc:
        return await message.answer(f"Ошибка учёта платежа: {exc}")
    await message.answer(f"Записана операция №{pid}: {parts[2]}, {rub(amount)}. Это учёт, не списание денег.")


@router.message(Command("report"))
async def report_cmd(message: Message):
    if not is_admin(message): return await message.answer("Доступ запрещён.")
    data=make_report(DB)
    date=datetime.now(timezone.utc).strftime("%Y%m%d_%H%M")
    await message.answer_document(BufferedInputFile(data,filename=f"atelier_report_{date}.xlsx"),
                                  caption="Учётная выгрузка. Платежи записываются вручную, не подтверждаются банком.")


@router.message()
async def fallback(message: Message):
    await message.answer("Используйте /start для выбора услуги; /cancel — чтобы прервать ввод.")


def main() -> None:
    global DB,ADMINS
    load_local_env()
    logging.basicConfig(level=logging.INFO)
    token=os.environ.get("BOT_TOKEN","").strip()
    if not token:
        raise SystemExit("BOT_TOKEN is required; see .env.example")
    admin_ids=os.environ.get("ADMIN_IDS","").strip()
    if not admin_ids:
        raise SystemExit("ADMIN_IDS is required: comma-separated numeric Telegram IDs")
    try: ADMINS={int(x.strip()) for x in admin_ids.split(",") if x.strip()}
    except ValueError: raise SystemExit("ADMIN_IDS must contain only integers") from None
    if not ADMINS: raise SystemExit("At least one admin ID is required")
    DB=Store(os.environ.get("DATABASE_PATH","data/atelier.sqlite3"))
    bot=Bot(token=token)
    dp=Dispatcher()
    dp.include_router(router)
    asyncio.run(dp.start_polling(bot))


if __name__ == "__main__":
    main()
