CREATE TABLE IF NOT EXISTS processed_updates (update_id INTEGER PRIMARY KEY, processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS customers (id INTEGER PRIMARY KEY, telegram_id INTEGER NOT NULL UNIQUE, full_name TEXT NOT NULL DEFAULT '', username TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY, category_id INTEGER NOT NULL REFERENCES categories(id), name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', photo_file_id TEXT, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS variants (id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id), sku TEXT NOT NULL UNIQUE, size TEXT NOT NULL, color TEXT NOT NULL, price_cents INTEGER NOT NULL CHECK(price_cents >= 0), cost_cents INTEGER NOT NULL CHECK(cost_cents >= 0), stock INTEGER NOT NULL CHECK(stock >= 0), active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS cart_items (customer_id INTEGER NOT NULL REFERENCES customers(id), variant_id INTEGER NOT NULL REFERENCES variants(id), quantity INTEGER NOT NULL CHECK(quantity > 0), PRIMARY KEY(customer_id, variant_id));
CREATE TABLE IF NOT EXISTS sessions (telegram_id INTEGER PRIMARY KEY, flow TEXT NOT NULL, step TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id), kind TEXT NOT NULL CHECK(kind IN ('catalog','custom')), status TEXT NOT NULL DEFAULT 'new', total_cents INTEGER NOT NULL DEFAULT 0, cost_cents INTEGER NOT NULL DEFAULT 0, quote_revision INTEGER NOT NULL DEFAULT 0, contact_name TEXT NOT NULL DEFAULT '', contact_phone TEXT NOT NULL DEFAULT '', delivery_address TEXT NOT NULL DEFAULT '', custom_details TEXT NOT NULL DEFAULT '', custom_measurements TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS order_items (id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id), variant_id INTEGER REFERENCES variants(id), product_name TEXT NOT NULL, size TEXT NOT NULL, color TEXT NOT NULL, quantity INTEGER NOT NULL, unit_price_cents INTEGER NOT NULL, unit_cost_cents INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS payments (id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id), kind TEXT NOT NULL, amount_cents INTEGER NOT NULL, reference TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE UNIQUE INDEX IF NOT EXISTS ix_cloud_payment_ref ON payments(reference) WHERE reference <> '';
CREATE TABLE IF NOT EXISTS status_history (id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id), old_status TEXT, new_status TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS ix_cloud_orders_status ON orders(status,created_at);
CREATE INDEX IF NOT EXISTS ix_cloud_orders_customer ON orders(customer_id);
-- Notifications are written in the order's transaction and delivered afterwards.
-- Rows hold only identifiers: the text is rendered from the order at delivery time.
CREATE TABLE IF NOT EXISTS notification_outbox (
  id INTEGER PRIMARY KEY,
  event_type TEXT NOT NULL,
  order_id INTEGER NOT NULL,
  recipient_id INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
  lease_until TEXT,
  delivered_at TEXT,
  failed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(event_type,order_id,recipient_id)
);
CREATE INDEX IF NOT EXISTS idx_notification_outbox_due
  ON notification_outbox(next_attempt_at) WHERE delivered_at IS NULL AND failed_at IS NULL;
CREATE TABLE IF NOT EXISTS reviews (id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id), customer_id INTEGER NOT NULL REFERENCES customers(id), author_name TEXT NOT NULL DEFAULT '', rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5), body TEXT NOT NULL, hidden INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(product_id,customer_id));
CREATE INDEX IF NOT EXISTS idx_reviews_product ON reviews(product_id,hidden,updated_at);
