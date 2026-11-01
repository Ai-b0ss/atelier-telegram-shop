-- Deliver status and quote notifications only after their business changes commit.
-- Triggers cover both Telegram bot commands and Mini App admin actions.
-- Event types include unique status/quote version; no personal information is stored here.
CREATE TRIGGER IF NOT EXISTS order_status_notification
AFTER UPDATE OF status ON orders
WHEN NEW.status <> OLD.status
BEGIN
  INSERT OR IGNORE INTO notification_outbox(event_type,order_id,recipient_id)
  SELECT 'status_' || NEW.status, NEW.id, c.telegram_id
  FROM customers c WHERE c.id=NEW.customer_id AND c.telegram_id > 0;
END;

CREATE TRIGGER IF NOT EXISTS order_quote_notification
AFTER UPDATE OF quote_revision ON orders
WHEN NEW.kind='custom' AND NEW.quote_revision > OLD.quote_revision
BEGIN
  INSERT OR IGNORE INTO notification_outbox(event_type,order_id,recipient_id)
  SELECT 'quote_' || NEW.quote_revision, NEW.id, c.telegram_id
  FROM customers c WHERE c.id=NEW.customer_id AND c.telegram_id > 0;
END;
