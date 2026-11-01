#!/usr/bin/env python3
"""Read-only Cloudflare demo smoke test. Never sends orders or uses credentials.

Checks publicly exposed routes only. Prints aggregate counts, never customer data.
Use with the existing demo deployment, not as proof of paid production readiness.
"""
from __future__ import annotations

import json
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

BASE = "https://atelier-customwear-demo-2026.igorekglukhovskii43.workers.dev"
MAX_BYTES = 256 * 1024


def get(path: str, attempts: int = 3):
    if not path.startswith("/") or path.startswith("//"):
        raise ValueError("Unsafe request path")
    for attempt in range(attempts):
        req = Request(BASE + path, headers={"User-Agent": "AtelierReadOnlyHealthCheck/1.0"})
        try:
            with urlopen(req, timeout=12) as response:
                data = response.read(MAX_BYTES + 1)
                if len(data) > MAX_BYTES:
                    raise AssertionError(f"{path}: response exceeded {MAX_BYTES} bytes")
                return response.status, response.headers, data
        except HTTPError as error:
            # Expected for unsigned admin routes; never print response bodies.
            return error.code, error.headers, b""
        except (URLError, TimeoutError) as error:
            if attempt + 1 >= attempts:
                raise AssertionError(f"{path}: unable to connect ({type(error).__name__})") from error
            time.sleep(attempt + 1)
    raise AssertionError("Unreachable")


def json_get(path):
    status, headers, body = get(path)
    assert status == 200, f"{path}: HTTP {status}"
    assert headers.get_content_type() == "application/json", f"{path}: not JSON"
    return json.loads(body)


def run():
    health = json_get("/health")
    assert health == {
        "ok": True, "bot": "atelier", "mode": "demo", "database": True
    }, "Unexpected health/mode/database state"
    print("Health: HTTP 200, database=true, demo mode preserved")

    catalog = json_get("/api/catalog")
    assert catalog.get("ok") is True and catalog.get("demo") is True, "Catalogue demo guard changed"
    products = catalog.get("products")
    variants = catalog.get("variants")
    assert isinstance(products, list) and len(products) >= 1, "No catalogue products"
    assert isinstance(variants, list) and len(variants) >= 1, "No catalogue variants"
    product_ids = {p.get("id") for p in products}
    assert len(product_ids) == len(products), "Duplicate product ID"
    assert all(isinstance(v.get("stock"), int)
               and v["stock"] >= 0
               and isinstance(v.get("price_cents"), int)
               and v["price_cents"] >= 0
               and v.get("product_id") in product_ids for v in variants), "Broken stock/prices"
    print(f"Catalogue: HTTP 200, {len(products)} products, {len(variants)} variants")

    status, headers, body = get("/app")
    assert status == 200 and headers.get_content_type() == "text/html", "Mini App unavailable"
    assert b"/app.js" in body and b"/style.css" in body, "Missing Mini App scripts/styles"
    csp = headers.get("Content-Security-Policy", "")
    assert "frame-ancestors 'none'" in csp, "CSP was weakened"
    print("Mini App: HTTP 200, expected assets and CSP")

    status, headers, body = get("/privacy")
    assert status == 200, f"/privacy: HTTP {status}"
    print("Privacy information: HTTP 200")

    # GET only. Do not send a Telegram token, submit any order or reveal admin data.
    for path in ("/api/me", "/api/cart", "/api/admin/dashboard"):
        status, _, _ = get(path)
        assert status in (401, 403), f"{path}: unexpected anonymous HTTP {status}"
    print("Unsigned personal/admin API: 3/3 denied")
    print("LIVE READ-ONLY SMOKE: PASSED")


if __name__ == "__main__":
    try:
        run()
    except (AssertionError, ValueError, TypeError, KeyError, json.JSONDecodeError) as exc:
        print(f"LIVE READ-ONLY SMOKE: FAILED: {exc}", file=sys.stderr)
        sys.exit(1)
