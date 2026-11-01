-- Seller-controlled settings. Intentionally not ready for real trade.
CREATE TABLE IF NOT EXISTS store_settings (
 id INTEGER PRIMARY KEY CHECK(id=1),
 legal_name TEXT NOT NULL DEFAULT '',
 tax_id TEXT NOT NULL DEFAULT '',
 support_contact TEXT NOT NULL DEFAULT '',
 pickup_address TEXT NOT NULL DEFAULT '',
 delivery_policy TEXT NOT NULL DEFAULT '',
 return_policy TEXT NOT NULL DEFAULT '',
 privacy_policy_url TEXT NOT NULL DEFAULT '',
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO store_settings(id) VALUES(1);
