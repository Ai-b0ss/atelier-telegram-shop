-- Mini App idempotency and Telegram photo references. No real checkout until sales readiness.
CREATE TABLE IF NOT EXISTS checkout_requests (
  telegram_id INTEGER NOT NULL,
  request_key TEXT NOT NULL,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (telegram_id, request_key)
);
CREATE INDEX IF NOT EXISTS ix_checkout_requests_created_at ON checkout_requests(created_at);
CREATE TABLE IF NOT EXISTS custom_attachments (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  telegram_file_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(order_id,telegram_file_id)
);
