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
