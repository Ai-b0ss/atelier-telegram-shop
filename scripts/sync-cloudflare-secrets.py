"""Sync existing local settings with Cloudflare using Wrangler's stdin interface.

No secret values are printed, passed as command-line arguments, written to a
temporary file, or transmitted to ChatGPT. Wrangler is the only network client.
"""
from __future__ import annotations

import json
import re
import secrets
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENV_FILE = ROOT / ".env"
WORKER = "atelier-customwear-demo-2026"
REQUIRED = ("BOT_TOKEN", "ADMIN_IDS", "WEBHOOK_SECRET")


def load_settings(path: Path) -> dict[str, str]:
    if not path.is_file():
        raise RuntimeError("Missing local .env")
    result = {}
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if key in REQUIRED:
            result[key] = value.strip().strip('"').strip("'")
    return result


def sync() -> None:
    settings = load_settings(ENV_FILE)
    if not re.fullmatch(r"[0-9]{5,12}:[A-Za-z0-9_-]{30,}", settings.get("BOT_TOKEN", "")):
        raise RuntimeError("Invalid BOT_TOKEN format")
    if not re.fullmatch(r"[1-9][0-9]*(,[1-9][0-9]*)*", settings.get("ADMIN_IDS", "")):
        raise RuntimeError("Invalid ADMIN_IDS format")

    webhook = settings.get("WEBHOOK_SECRET", "")
    if not webhook:
        webhook = secrets.token_urlsafe(32)
        with ENV_FILE.open("a", encoding="utf-8") as fh:
            fh.write("\nWEBHOOK_SECRET=" + webhook + "\n")
        settings["WEBHOOK_SECRET"] = webhook
    if not re.fullmatch(r"[A-Za-z0-9_-]{32,128}", webhook):
        raise RuntimeError("Invalid WEBHOOK_SECRET format")

    command = [
        "npx.cmd", "--yes", "wrangler@4.156.0", "secret", "bulk",
        "--name", WORKER,
    ]
    payload = json.dumps({key: settings[key] for key in REQUIRED}, ensure_ascii=True)
    completed = subprocess.run(
        command, input=payload, text=True, capture_output=True,
        cwd=ROOT / "cloudflare", timeout=120, check=False,
    )
    if completed.returncode:
        raise RuntimeError("Wrangler failed; exit code " + str(completed.returncode))
    verify = subprocess.run(
        ["npx.cmd", "--yes", "wrangler@4.156.0", "secret", "list", "--name", WORKER],
        text=True, capture_output=True, cwd=ROOT / "cloudflare", timeout=120,
        check=False,
    )
    if verify.returncode:
        raise RuntimeError("Secret name verification failed")
    listed = json.loads(verify.stdout)
    names = {item["name"] for item in listed}
    if not set(REQUIRED).issubset(names):
        raise RuntimeError("Cloudflare secret list is incomplete")
    print("Cloudflare credentials synchronized and verified by name (3/3).")


if __name__ == "__main__":
    sync()
