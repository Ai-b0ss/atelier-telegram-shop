"""Populate a demo catalogue once, without overwriting existing products."""
import os
from .store import Store

if __name__ == "__main__":
    db = Store(os.environ.get("DATABASE_PATH", "data/atelier.sqlite3"))
    db.seed_demo()
    print("Demo catalogue prepared")
