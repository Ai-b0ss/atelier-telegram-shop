-- Telegram file IDs let the bot resend a product photo without Telegram downloading it again.
CREATE TABLE IF NOT EXISTS photo_cache (path TEXT PRIMARY KEY, file_id TEXT NOT NULL);
