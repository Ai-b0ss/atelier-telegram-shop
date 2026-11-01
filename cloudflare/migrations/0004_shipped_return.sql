-- No artificial stock increase when a shipment is cancelled after dispatch.
-- Replacing the trigger changes only future transitions; historic orders stay unchanged.
DROP TRIGGER IF EXISTS trg_atelier_cancel_restocks;
CREATE TRIGGER trg_atelier_cancel_restocks
AFTER UPDATE OF status ON orders
WHEN NEW.status='canceled'
 AND OLD.status<>'canceled'
 AND NEW.kind='catalog'
 AND OLD.status NOT IN ('shipped','completed')
 AND NOT EXISTS (
   SELECT 1 FROM status_history h
   WHERE h.order_id=NEW.id AND h.new_status='shipped'
 )
BEGIN
 UPDATE variants
 SET stock=stock+COALESCE((
   SELECT SUM(i.quantity) FROM order_items i
   WHERE i.order_id=NEW.id AND i.variant_id=variants.id
 ),0)
 WHERE id IN (
   SELECT DISTINCT variant_id FROM order_items
   WHERE order_id=NEW.id AND variant_id IS NOT NULL
 );
END;

-- Receipt of physically returned goods is a separate documented transaction.
CREATE TABLE IF NOT EXISTS inventory_return_receipts (
 id INTEGER PRIMARY KEY,
 order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id),
 accepted_by INTEGER NOT NULL,
 note TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER IF NOT EXISTS trg_atelier_validate_inventory_return
BEFORE INSERT ON inventory_return_receipts
WHEN NOT EXISTS (
 SELECT 1 FROM orders o WHERE o.id=NEW.order_id
 AND o.kind='catalog' AND o.status='canceled'
 AND EXISTS (
  SELECT 1 FROM status_history h WHERE h.order_id=o.id AND h.new_status='shipped'
 )
)
BEGIN
 SELECT RAISE(ABORT,'Physical return requires cancelled previously shipped catalog order');
END;

CREATE TRIGGER IF NOT EXISTS trg_atelier_apply_inventory_return
AFTER INSERT ON inventory_return_receipts
BEGIN
 UPDATE variants
 SET stock=stock+COALESCE((
  SELECT SUM(i.quantity) FROM order_items i
  WHERE i.order_id=NEW.order_id AND i.variant_id=variants.id
 ),0)
 WHERE id IN (
  SELECT DISTINCT variant_id FROM order_items
  WHERE order_id=NEW.order_id AND variant_id IS NOT NULL
 );
END;
