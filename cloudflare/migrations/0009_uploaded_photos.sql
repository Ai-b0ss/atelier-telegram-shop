-- Photos an administrator sends to the bot, stored as Telegram file IDs in display order.
ALTER TABLE products ADD COLUMN photo_ids TEXT;
