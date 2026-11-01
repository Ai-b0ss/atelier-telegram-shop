-- Online migration requires stopping Telegram webhook before changing JS order handlers.
-- Trigger is idempotent to status writes and automatically restores inventory exactly once.
CREATE TRIGGER IF NOT EXISTS trg_atelier_cancel_restocks
AFTER UPDATE OF status ON orders
WHEN NEW.status = 'canceled' AND OLD.status <> 'canceled' AND NEW.kind = 'catalog'
BEGIN
  UPDATE variants
  SET stock = stock + COALESCE((
    SELECT SUM(i.quantity) FROM order_items i
    WHERE i.order_id = NEW.id AND i.variant_id = variants.id
  ),0)
  WHERE id IN (
    SELECT DISTINCT variant_id FROM order_items
    WHERE order_id = NEW.id AND variant_id IS NOT NULL
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_atelier_status_history
AFTER UPDATE OF status ON orders
WHEN OLD.status <> NEW.status
BEGIN
  INSERT INTO status_history(order_id,old_status,new_status)
  VALUES(NEW.id,OLD.status,NEW.status);
END;
