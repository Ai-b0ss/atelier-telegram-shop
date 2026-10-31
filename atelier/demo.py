"""Produce a self-contained synthetic demo database and Excel workbook.

Never connects to Telegram and never uses real customer data. Files are
created exclusively, so this command cannot overwrite production files.
"""
from __future__ import annotations

import argparse
from pathlib import Path

from .reports import make_report
from .store import Store


def build_demo(destination: Path) -> tuple[Path, Path, dict[str, int]]:
    destination = destination.resolve()
    destination.mkdir(parents=True, exist_ok=True)
    db_path = destination / "demo.sqlite3"
    excel_path = destination / "demo_report.xlsx"
    if db_path.exists() or excel_path.exists():
        raise FileExistsError("Demo files already exist; choose an empty directory")

    # Create without overwriting; the SQLite database is isolated from the live store.
    with db_path.open("xb"):
        pass
    try:
        store = Store(db_path)
        store.seed_demo()
        variants = [r["id"] for r in store.variants(store.products(1)[0]["id"])]
        first = store.customer(20260001, "Демо: покупатель 1", "demo_1")
        store.add_to_cart(first, variants[0])
        oid1 = store.checkout(first, "Демо: покупатель 1", "@demo_1", "Самовывоз")
        amount = store.order(oid1)["total_cents"]
        store.record_payment(oid1, "received", amount,
                             reference="DEMO-BANK-0001")
        for status in ("confirmed", "ready", "completed"):
            store.set_status(oid1, status)

        second = store.customer(20260002, "Демо: покупатель 2", "demo_2")
        oid2 = store.custom_order(second, "Демо: покупатель 2", "@demo_2", "Доставка",
                                  "Пальто из шерсти с авторской вышивкой", "Рост 174 см")
        revision = store.set_custom_price(oid2, 1850000, 840000)
        store.decide_custom_quote(oid2, 20260002, revision, 1850000, accept=True)
        store.record_payment(oid2, "received", 550000,
                             reference="DEMO-BANK-0002")
        store.set_status(oid2, "in_production")

        third = store.customer(20260003, "Демо: покупатель 3", "demo_3")
        store.add_to_cart(third, variants[0])
        oid3 = store.checkout(third, "Демо: покупатель 3", "@demo_3", "Самовывоз")
        store.record_payment(oid3, "received", 100000, reference="DEMO-BANK-0003")
        store.record_payment(oid3, "refunded", 100000, reference="DEMO-REFUND-0003")
        store.set_status(oid3, "canceled")
        with excel_path.open("xb") as output:
            output.write(make_report(store))
        return db_path, excel_path, store.analytics()
    except BaseException:
        excel_path.unlink(missing_ok=True)
        for path in (db_path, Path(str(db_path) + "-wal"), Path(str(db_path) + "-shm")):
            path.unlink(missing_ok=True)
        raise


def cli(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Generate a realistic synthetic atelier demo")
    parser.add_argument("directory", type=Path, help="Empty output directory (demo data only)")
    args = parser.parse_args(argv)
    try:
        database, report, totals = build_demo(args.directory)
    except (ValueError, FileExistsError, OSError) as exc:
        parser.error(str(exc))
    print(f"Demo DB: {database}\nExcel: {report}")
    print(f"Orders: {totals['order_count']}; "
          f"net cash receipts: {totals['net_receipts_cents'] / 100:.2f} RUB; "
          f"completed order value: {totals['completed_revenue_cents'] / 100:.2f} RUB")


if __name__ == "__main__":
    cli()
