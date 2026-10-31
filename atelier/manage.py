"""Offline catalogue administration CLI (no network or Telegram credentials required)."""
from __future__ import annotations

import argparse
import os
from .store import Store, StoreError
from decimal import Decimal, InvalidOperation


def money_to_cents(text: str) -> int:
    try:
        value = Decimal(text.replace(",", ".")) * 100
        if not value.is_finite() or value < 0 or value != value.to_integral_value():
            raise ValueError
        return int(value)
    except (InvalidOperation, ValueError):
        raise StoreError("Invalid amount") from None


def cli(argv: list[str] | None = None) -> None:
    p=argparse.ArgumentParser(description="Manage an atelier catalogue in SQLite")
    sub=p.add_subparsers(dest="action",required=True)
    x=sub.add_parser("category",help="Add category");x.add_argument("name")
    x=sub.add_parser("product",help="Add a product");x.add_argument("category_id",type=int);x.add_argument("name");x.add_argument("description")
    x=sub.add_parser("variant",help="Add a SKU/size/color/price/cost/stock")
    x.add_argument("product_id",type=int);x.add_argument("sku");x.add_argument("size");x.add_argument("color")
    x.add_argument("price");x.add_argument("cost");x.add_argument("stock",type=int)
    x=sub.add_parser("stock",help="Set available stock");x.add_argument("variant_id",type=int);x.add_argument("qty",type=int)
    x=sub.add_parser("photo",help="Set existing Telegram file_id");x.add_argument("product_id",type=int);x.add_argument("file_id")
    x=sub.add_parser("deactivate",help="Hide a product from catalogue");x.add_argument("product_id",type=int)
    x=sub.add_parser("list",help="Print all variants")
    args=p.parse_args(argv)
    db=Store(os.environ.get("DATABASE_PATH","data/atelier.sqlite3"))
    try:
        with db.connection() as con:
            if args.action=="category":
                cur=con.execute("INSERT INTO categories(name) VALUES(?)",(args.name,))
            elif args.action=="product":
                cur=con.execute("INSERT INTO products(category_id,name,description) VALUES(?,?,?)",
                                (args.category_id,args.name,args.description))
            elif args.action=="variant":
                if args.stock<0: raise StoreError("Stock must be >=0")
                cur=con.execute("INSERT INTO variants(product_id,sku,size,color,price_cents,cost_cents,stock) VALUES(?,?,?,?,?,?,?)",
                                (args.product_id,args.sku,args.size,args.color,money_to_cents(args.price),money_to_cents(args.cost),args.stock))
            elif args.action=="stock":
                if args.qty<0: raise StoreError("Stock must be >=0")
                cur=con.execute("UPDATE variants SET stock=? WHERE id=?",(args.qty,args.variant_id))
            elif args.action=="photo":
                cur=con.execute("UPDATE products SET photo_file_id=? WHERE id=?",(args.file_id,args.product_id))
            elif args.action=="deactivate":
                cur=con.execute("UPDATE products SET active=0 WHERE id=?",(args.product_id,))
            else:
                for row in con.execute("SELECT v.id,v.sku,p.name,v.size,v.color,v.stock, v.price_cents "
                                       "FROM variants v JOIN products p ON p.id=v.product_id ORDER BY v.id"):
                    print(tuple(row))
                return
            if cur.rowcount == 0: raise StoreError("ID not found")
            print("Saved",cur.lastrowid if args.action in ("category","product","variant") else "")
    except (StoreError,ValueError) as exc:
        p.error(str(exc))


if __name__=="__main__":
    cli()
