"""Transactional SQLite domain layer for a small made-to-order atelier."""
from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

STATUSES = ("new", "confirmed", "in_production", "ready", "shipped", "completed", "canceled")
TRANSITIONS = {
    "new": {"confirmed", "canceled"},
    "confirmed": {"in_production", "ready", "canceled"},
    "in_production": {"ready", "canceled"},
    "ready": {"shipped", "completed", "canceled"},
    "shipped": {"completed", "canceled"},
    "completed": set(),
    "canceled": set(),
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS customers (
 id INTEGER PRIMARY KEY, telegram_id INTEGER NOT NULL UNIQUE,
 username TEXT, name TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS categories (
 id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS products (
 id INTEGER PRIMARY KEY, category_id INTEGER NOT NULL REFERENCES categories(id),
 name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
 photo_file_id TEXT, active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))
);
CREATE TABLE IF NOT EXISTS variants (
 id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id),
 sku TEXT NOT NULL UNIQUE, size TEXT NOT NULL, color TEXT NOT NULL,
 price_cents INTEGER NOT NULL CHECK(price_cents>=0),
 cost_cents INTEGER NOT NULL CHECK(cost_cents>=0),
 stock INTEGER NOT NULL CHECK(stock>=0),
 active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))
);
CREATE TABLE IF NOT EXISTS cart_items (
 customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
 variant_id INTEGER NOT NULL REFERENCES variants(id),
 quantity INTEGER NOT NULL CHECK(quantity>0), PRIMARY KEY(customer_id, variant_id)
);
CREATE TABLE IF NOT EXISTS orders (
 id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id),
 kind TEXT NOT NULL CHECK(kind IN ('catalog', 'custom')),
 status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','confirmed','in_production','ready','shipped','completed','canceled')),
 total_cents INTEGER NOT NULL DEFAULT 0 CHECK(total_cents>=0),
 cost_cents INTEGER NOT NULL DEFAULT 0 CHECK(cost_cents>=0),
 contact_name TEXT NOT NULL, contact_phone TEXT NOT NULL, delivery_address TEXT NOT NULL,
 custom_details TEXT NOT NULL DEFAULT '', custom_measurements TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS order_items (
 id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id),
 variant_id INTEGER REFERENCES variants(id) ON DELETE SET NULL,
 product_name TEXT NOT NULL, size TEXT NOT NULL, color TEXT NOT NULL,
 quantity INTEGER NOT NULL CHECK(quantity>0),
 unit_price_cents INTEGER NOT NULL CHECK(unit_price_cents>=0),
 unit_cost_cents INTEGER NOT NULL CHECK(unit_cost_cents>=0)
);
CREATE TABLE IF NOT EXISTS payments (
 id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id),
 kind TEXT NOT NULL CHECK(kind IN ('received','refunded')),
 amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
 note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS status_history (
 id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id),
 old_status TEXT, new_status TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_orders_status ON orders(status, created_at);
CREATE INDEX IF NOT EXISTS ix_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS ix_payments_order ON payments(order_id);
"""


class StoreError(ValueError):
    """User-correctable domain error."""


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Store:
    def __init__(self, path: str | Path):
        self.path = str(path)
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self.init()

    @contextmanager
    def connection(self) -> Iterator[sqlite3.Connection]:
        db = sqlite3.connect(self.path, timeout=8)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("PRAGMA busy_timeout=8000")
        try:
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    def init(self) -> None:
        with self.connection() as db:
            db.executescript(SCHEMA)
            db.execute("PRAGMA journal_mode=WAL")

    def customer(self, tg_id: int, name: str = "", username: str = "") -> int:
        with self.connection() as db:
            db.execute("INSERT INTO customers(telegram_id,username,name,created_at,updated_at) VALUES(?,?,?,?,?) "
                       "ON CONFLICT(telegram_id) DO UPDATE SET username=excluded.username, "
                       "name=CASE WHEN excluded.name<>'' THEN excluded.name ELSE customers.name END, updated_at=excluded.updated_at",
                       (tg_id, username, name, now(), now()))
            return int(db.execute("SELECT id FROM customers WHERE telegram_id=?", (tg_id,)).fetchone()[0])

    def categories(self) -> list[sqlite3.Row]:
        with self.connection() as db:
            return db.execute("SELECT c.id,c.name,COUNT(p.id) AS items FROM categories c LEFT JOIN products p "
                              "ON p.category_id=c.id AND p.active=1 GROUP BY c.id ORDER BY c.name").fetchall()

    def products(self, category_id: int) -> list[sqlite3.Row]:
        with self.connection() as db:
            return db.execute("SELECT p.*, MIN(v.price_cents) AS min_price FROM products p "
                              "JOIN variants v ON v.product_id=p.id AND v.active=1 "
                              "WHERE p.active=1 AND p.category_id=? GROUP BY p.id ORDER BY p.id", (category_id,)).fetchall()

    def product(self, product_id: int) -> sqlite3.Row | None:
        with self.connection() as db:
            return db.execute("SELECT * FROM products WHERE id=? AND active=1", (product_id,)).fetchone()

    def variants(self, product_id: int) -> list[sqlite3.Row]:
        with self.connection() as db:
            return db.execute("SELECT * FROM variants WHERE product_id=? AND active=1 AND stock>0 ORDER BY size,color",
                              (product_id,)).fetchall()

    def add_to_cart(self, customer_id: int, variant_id: int, count: int = 1) -> None:
        if count <= 0 or count > 100:
            raise StoreError("Недопустимое количество")
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            variant = db.execute("SELECT v.stock,v.active,p.active AS product_active FROM variants v "
                                 "JOIN products p ON p.id=v.product_id WHERE v.id=?", (variant_id,)).fetchone()
            if not variant or not variant["active"] or not variant["product_active"]:
                raise StoreError("Товар недоступен")
            existing = db.execute("SELECT quantity FROM cart_items WHERE customer_id=? AND variant_id=?",
                                  (customer_id, variant_id)).fetchone()
            qty = (existing[0] if existing else 0) + count
            if qty > variant["stock"]:
                raise StoreError("Недостаточно товара в наличии")
            db.execute("INSERT INTO cart_items(customer_id,variant_id,quantity) VALUES(?,?,?) "
                       "ON CONFLICT(customer_id,variant_id) DO UPDATE SET quantity=excluded.quantity",
                       (customer_id, variant_id, qty))

    def remove_from_cart(self, customer_id: int, variant_id: int) -> None:
        with self.connection() as db:
            db.execute("DELETE FROM cart_items WHERE customer_id=? AND variant_id=?", (customer_id, variant_id))

    def cart(self, customer_id: int) -> list[sqlite3.Row]:
        with self.connection() as db:
            return db.execute("SELECT ci.variant_id, ci.quantity, p.name, v.size, v.color, v.price_cents, "
                              "v.stock FROM cart_items ci JOIN variants v ON v.id=ci.variant_id "
                              "JOIN products p ON p.id=v.product_id WHERE ci.customer_id=? ORDER BY ci.variant_id",
                              (customer_id,)).fetchall()

    @staticmethod
    def _valid_contact(name: str, phone: str, address: str) -> None:
        if not name.strip() or not phone.strip() or not address.strip():
            raise StoreError("Укажите имя, контакт и способ получения/адрес")
        if max(len(name), len(phone), len(address)) > 500:
            raise StoreError("Слишком длинные контактные данные")

    def checkout(self, customer_id: int, name: str, phone: str, address: str) -> int:
        self._valid_contact(name, phone, address)
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            items = db.execute("SELECT ci.*,v.price_cents,v.cost_cents,v.stock,v.size,v.color,"
                               "v.active,p.name,p.active AS product_active FROM cart_items ci "
                               "JOIN variants v ON ci.variant_id=v.id JOIN products p ON v.product_id=p.id "
                               "WHERE ci.customer_id=? ORDER BY ci.variant_id", (customer_id,)).fetchall()
            if not items:
                raise StoreError("Корзина пуста")
            if any(i["quantity"] > i["stock"] or not i["active"] or not i["product_active"] for i in items):
                raise StoreError("Один из товаров закончился или недоступен — проверьте корзину")
            for item in items:
                updated = db.execute("UPDATE variants SET stock=stock-? WHERE id=? AND stock>=? AND active=1",
                                     (item["quantity"], item["variant_id"], item["quantity"]))
                if updated.rowcount != 1:
                    raise StoreError("Недостаточно остатков — обновите корзину")
            total = sum(i["price_cents"] * i["quantity"] for i in items)
            cost = sum(i["cost_cents"] * i["quantity"] for i in items)
            timestamp = now()
            cur = db.execute("INSERT INTO orders(customer_id,kind,total_cents,cost_cents,contact_name,contact_phone,"
                             "delivery_address,created_at,updated_at) VALUES(?,'catalog',?,?,?,?,?,?,?)",
                             (customer_id,total,cost,name.strip(),phone.strip(),address.strip(),timestamp,timestamp))
            order_id = int(cur.lastrowid)
            for item in items:
                db.execute("INSERT INTO order_items(order_id,variant_id,product_name,size,color,quantity,"
                           "unit_price_cents,unit_cost_cents) VALUES(?,?,?,?,?,?,?,?)",
                           (order_id,item["variant_id"],item["name"],item["size"],item["color"],
                            item["quantity"],item["price_cents"],item["cost_cents"]))
            db.execute("INSERT INTO status_history(order_id,old_status,new_status,created_at) VALUES(?,NULL,'new',?)",
                       (order_id,timestamp))
            db.execute("DELETE FROM cart_items WHERE customer_id=?", (customer_id,))
            return order_id

    def custom_order(self, customer_id: int, name: str, phone: str, address: str,
                     details: str, measurements: str) -> int:
        self._valid_contact(name,phone,address)
        if len(details.strip()) < 10 or len(details) > 3000 or len(measurements) > 1000:
            raise StoreError("Опишите пожелания к изделию (от 10 до 3000 символов)")
        with self.connection() as db:
            stamp = now()
            cur = db.execute("INSERT INTO orders(customer_id,kind,contact_name,contact_phone,delivery_address,"
                             "custom_details,custom_measurements,created_at,updated_at) VALUES(?,'custom',?,?,?,?,?,?,?)",
                             (customer_id,name.strip(),phone.strip(),address.strip(),details.strip(),
                              measurements.strip(),stamp,stamp))
            oid = int(cur.lastrowid)
            db.execute("INSERT INTO status_history(order_id,old_status,new_status,created_at) VALUES(?,NULL,'new',?)",
                       (oid,stamp))
            return oid

    def order(self, order_id: int) -> sqlite3.Row | None:
        with self.connection() as db:
            return db.execute("SELECT o.*,c.telegram_id,c.username FROM orders o "
                              "JOIN customers c ON c.id=o.customer_id WHERE o.id=?",(order_id,)).fetchone()

    def customer_orders(self, customer_id: int) -> list[sqlite3.Row]:
        with self.connection() as db:
            return db.execute("SELECT * FROM orders WHERE customer_id=? ORDER BY id DESC LIMIT 30",(customer_id,)).fetchall()

    def list_orders(self, status: str | None = None, limit: int = 30) -> list[sqlite3.Row]:
        if status is not None and status not in STATUSES:
            raise StoreError("Неизвестный статус")
        if not 1 <= limit <= 200:
            raise StoreError("Недопустимый лимит")
        with self.connection() as db:
            return db.execute("SELECT o.*,c.telegram_id FROM orders o JOIN customers c ON c.id=o.customer_id "
                              "WHERE (? IS NULL OR o.status=?) ORDER BY o.id DESC LIMIT ?",(status,status,limit)).fetchall()

    def set_custom_price(self, order_id: int, total_cents: int, cost_cents: int) -> None:
        if total_cents <= 0 or cost_cents < 0 or total_cents > 100_000_000_00:
            raise StoreError("Некорректная цена или себестоимость")
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            order = db.execute("SELECT kind,status FROM orders WHERE id=?",(order_id,)).fetchone()
            if not order or order["kind"]!="custom" or order["status"]!="new":
                raise StoreError("Смета задаётся только новому индивидуальному заказу")
            if db.execute("SELECT COUNT(*) FROM payments WHERE order_id=?",(order_id,)).fetchone()[0]:
                raise StoreError("Нельзя менять цену после записи платежей")
            db.execute("UPDATE orders SET total_cents=?,cost_cents=?,updated_at=? WHERE id=?",
                       (total_cents,cost_cents,now(),order_id))

    def set_status(self, order_id: int, status: str) -> None:
        if status not in STATUSES:
            raise StoreError("Неизвестный статус")
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            order = db.execute("SELECT status,kind,total_cents FROM orders WHERE id=?",(order_id,)).fetchone()
            if not order:
                raise StoreError("Заказ не найден")
            if status not in TRANSITIONS[order["status"]]:
                raise StoreError(f"Переход {order['status']} → {status} запрещён")
            if status=="confirmed" and order["kind"]=="custom" and order["total_cents"]==0:
                raise StoreError("Сначала укажите цену индивидуального заказа")
            if status=="canceled":
                # Cancellation cannot silently erase already received money.
                net = db.execute("SELECT COALESCE(SUM(CASE kind WHEN 'received' THEN amount_cents "
                                 "ELSE -amount_cents END),0) FROM payments WHERE order_id=?",(order_id,)).fetchone()[0]
                if net:
                    raise StoreError("Перед отменой проведите возврат всех полученных платежей")
                # Shipping has already transferred the goods out of our custody.
                # A post-shipment return requires explicit inspection and restocking;
                # simply canceling the order must not produce phantom inventory.
                if order["kind"]=="catalog" and order["status"]!="shipped":
                    for item in db.execute("SELECT variant_id,quantity FROM order_items WHERE order_id=?",(order_id,)):
                        if item["variant_id"] is not None:
                            db.execute("UPDATE variants SET stock=stock+? WHERE id=?",(item["quantity"],item["variant_id"]))
            stamp=now()
            db.execute("UPDATE orders SET status=?,updated_at=? WHERE id=?",(status,stamp,order_id))
            db.execute("INSERT INTO status_history(order_id,old_status,new_status,created_at) VALUES(?,?,?,?)",
                       (order_id,order["status"],status,stamp))

    def record_payment(self, order_id: int, kind: str, amount_cents: int, note: str = "") -> int:
        if kind not in ("received","refunded") or amount_cents<=0 or amount_cents>100_000_000_00:
            raise StoreError("Некорректный тип или сумма платежа")
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            o=db.execute("SELECT total_cents,status FROM orders WHERE id=?",(order_id,)).fetchone()
            if not o or o["status"]=="canceled":
                raise StoreError("Заказ недоступен")
            sums=db.execute("SELECT COALESCE(SUM(CASE kind WHEN 'received' THEN amount_cents ELSE -amount_cents END),0) "
                            "FROM payments WHERE order_id=?",(order_id,)).fetchone()[0]
            if kind=="received" and (o["total_cents"]==0 or sums+amount_cents>o["total_cents"]):
                raise StoreError("Оплата превысит стоимость заказа или цена не установлена")
            if kind=="refunded" and amount_cents>sums:
                raise StoreError("Возврат превышает полученную сумму")
            cur=db.execute("INSERT INTO payments(order_id,kind,amount_cents,note,created_at) VALUES(?,?,?,?,?)",
                           (order_id,kind,amount_cents,note[:300],now()))
            return int(cur.lastrowid)

    def anonymize_customer(self, telegram_id: int) -> bool:
        """Erase personal details while retaining anonymized transactional totals.

        Open orders block erasure; a new account row will be created on next /start.
        Returns False if there was no matching customer.
        """
        if telegram_id <= 0:
            raise StoreError("Некорректный Telegram ID")
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            customer = db.execute("SELECT id FROM customers WHERE telegram_id=?", (telegram_id,)).fetchone()
            if customer is None:
                return False
            cid = customer["id"]
            open_orders = db.execute("SELECT COUNT(*) FROM orders WHERE customer_id=? AND "
                                     "status NOT IN ('completed','canceled')", (cid,)).fetchone()[0]
            if open_orders:
                raise StoreError("У вас есть незавершённые заказы. Сначала закройте их с менеджером")
            db.execute("DELETE FROM cart_items WHERE customer_id=?", (cid,))
            db.execute("UPDATE orders SET contact_name='[удалено]',contact_phone='[удалено]',"
                       "delivery_address='[удалено]',custom_details='',custom_measurements='' "
                       "WHERE customer_id=?", (cid,))
            db.execute("UPDATE customers SET telegram_id=?,username=NULL,name='',phone='',updated_at=? "
                       "WHERE id=?", (-cid, now(), cid))
            return True

    def analytics(self) -> dict[str,int]:
        with self.connection() as db:
            gross=db.execute("SELECT COALESCE(SUM(CASE kind WHEN 'received' THEN amount_cents ELSE -amount_cents END),0) "
                             "FROM payments").fetchone()[0]
            costs=db.execute("SELECT COALESCE(SUM(cost_cents),0) FROM orders WHERE status='completed'").fetchone()[0]
            earned=db.execute("SELECT COALESCE(SUM(total_cents),0) FROM orders WHERE status='completed'").fetchone()[0]
            placed=db.execute("SELECT COALESCE(SUM(total_cents),0) FROM orders WHERE status!='canceled'").fetchone()[0]
            count=db.execute("SELECT COUNT(*) FROM orders").fetchone()[0]
            return {"net_receipts_cents":gross,"completed_revenue_cents":earned,
                    "completed_cost_cents":costs,"completed_gross_margin_cents":earned-costs,
                    "indicative_margin_cents":gross-costs,
                    "active_orders_value_cents":placed,"order_count":count}

    def export_rows(self) -> tuple[list[sqlite3.Row],list[sqlite3.Row],list[sqlite3.Row]]:
        with self.connection() as db:
            orders=db.execute("SELECT o.*,c.telegram_id,"
                "COALESCE((SELECT SUM(CASE kind WHEN 'received' THEN amount_cents ELSE -amount_cents END) "
                "FROM payments WHERE order_id=o.id),0) AS paid_cents "
                "FROM orders o JOIN customers c ON c.id=o.customer_id ORDER BY o.id").fetchall()
            payments=db.execute("SELECT * FROM payments ORDER BY id").fetchall()
            variants=db.execute("SELECT v.*,p.name AS product_name FROM variants v JOIN products p ON p.id=v.product_id ORDER BY v.id").fetchall()
            return orders,payments,variants

    def seed_demo(self) -> None:
        with self.connection() as db:
            if db.execute("SELECT COUNT(*) FROM categories").fetchone()[0]:
                return
            for cat,name,desc,sku,size,color,price,cost,stock in [
                ("Худи","Худи ручной работы","Плотный хлопок, индивидуальная отделка", "HOODIE-M-BLK","M","чёрный",790000,390000,8),
                ("Футболки","Футболка с авторским принтом","Печать по индивидуальному дизайну", "TSHIRT-L-WHT","L","белый",320000,110000,12),
                ("Аксессуары","Сумка-шоппер","Текстиль, ручная роспись", "TOTE-UNI","one size","молочный",250000,95000,5),
            ]:
                cur=db.execute("INSERT INTO categories(name) VALUES(?)",(cat,))
                prod=db.execute("INSERT INTO products(category_id,name,description) VALUES(?,?,?)",(cur.lastrowid,name,desc))
                db.execute("INSERT INTO variants(product_id,sku,size,color,price_cents,cost_cents,stock) VALUES(?,?,?,?,?,?,?)",
                           (prod.lastrowid,sku,size,color,price,cost,stock))
