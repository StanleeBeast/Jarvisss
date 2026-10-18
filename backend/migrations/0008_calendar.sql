-- JARVIS Kalender (nur lesen): Zwischenspeicher der Termine aus dem freigegebenen Abo-Link.
-- Der Link selbst liegt in user_settings ('calendar_url').
CREATE TABLE IF NOT EXISTS calendar_cache (
  id TEXT PRIMARY KEY NOT NULL,
  fetched_at TEXT NOT NULL,
  events TEXT NOT NULL DEFAULT '[]',
  error TEXT
);
