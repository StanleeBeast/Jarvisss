-- Website-Studio: Entwürfe für Websites (z. B. für lokale Firmen), Vorschau in der App, Veröffentlichung auf Wunsch.
CREATE TABLE IF NOT EXISTS websites (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  brief TEXT NOT NULL DEFAULT '{}',
  files TEXT NOT NULL DEFAULT '{}',
  previous TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft',
  url TEXT,
  published_version INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_websites_updated ON websites (updated_at);
