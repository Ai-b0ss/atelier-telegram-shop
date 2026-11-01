#!/usr/bin/env python3
"""Offline visual-preview server. Synthetic fixture; NEVER connects to production D1/Telegram."""
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
import json
import sys
from urllib.parse import urlsplit

PUBLIC = Path(__file__).resolve().parents[1] / "cloudflare" / "public"
CATALOG = {
    "ok": True,
    "categories": [
        {"id": 1, "name": "Аксессуары"},
        {"id": 2, "name": "Футболки"},
        {"id": 3, "name": "Худи"},
    ],
    "products": [
        {"id": 1, "category_id": 1, "name": "Сумка-шоппер", "description": "Текстиль, ручная роспись (демонстрационный товар)", "photo_available": False},
        {"id": 2, "category_id": 2, "name": "Футболка с принтом", "description": "Хлопок, авторский принт (демонстрационный товар)", "photo_available": False},
        {"id": 3, "category_id": 3, "name": "Худи с вышивкой", "description": "Утеплённый хлопок, вышивка (демонстрационный товар)", "photo_available": False},
    ],
    "variants": [
        {"id": 1, "product_id": 1, "size": "one size", "color": "молочный", "price_cents": 250000, "stock": 5},
        {"id": 2, "product_id": 2, "size": "S", "color": "белый", "price_cents": 300000, "stock": 8},
        {"id": 3, "product_id": 2, "size": "M", "color": "белый", "price_cents": 300000, "stock": 8},
        {"id": 4, "product_id": 3, "size": "M", "color": "серый", "price_cents": 650000, "stock": 4},
    ],
}

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PUBLIC), **kwargs)

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/api/catalog":
            return self.json_response(CATALOG)
        if path == "/api/cart":
            return self.json_response({"ok": True, "items": [], "total_cents": 0})
        if path == "/api/me":
            return self.json_response({"ok": True, "admin": False, "demo": True, "user": None})
        if path in ("/app", "/admin", "/"):
            self.path = "/index.html"
        return super().do_GET()

    def do_POST(self):
        return self.json_response({"ok": False, "error": "Offline preview: mutations disabled"}, status=403)

    def json_response(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

if __name__ == "__main__":
    host, port = "127.0.0.1", int(sys.argv[1]) if len(sys.argv) > 1 else 8769
    print(f"Preview: http://{host}:{port}/app (synthetic only)", flush=True)
    ThreadingHTTPServer((host, port), Handler).serve_forever()
