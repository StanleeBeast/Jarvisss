-- JARVIS Mail über die Home-Station (Laptop). Gespeichert werden nur Absender, Betreff, Datum, ein kurzer Auszug,
-- die KI-Einstufung und ein Antwortentwurf – nie der vollständige Mailtext und nie Postfach-Passwörter.
CREATE TABLE IF NOT EXISTS station_status (
  device_id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  version TEXT,
  last_seen_at TEXT NOT NULL,
  accounts TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS mail_messages (
  id TEXT PRIMARY KEY NOT NULL,
  account TEXT NOT NULL,
  account_label TEXT NOT NULL,
  uid TEXT NOT NULL,
  message_id TEXT,
  from_name TEXT,
  from_addr TEXT,
  subject TEXT NOT NULL,
  received_at TEXT NOT NULL,
  snippet TEXT,
  importance INTEGER NOT NULL CHECK (importance BETWEEN 1 AND 5),
  category TEXT NOT NULL,
  summary TEXT,
  reason TEXT,
  needs_reply INTEGER NOT NULL DEFAULT 0,
  draft TEXT,
  suspicious INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('new', 'read', 'done', 'replied', 'sending', 'send_failed')),
  analyzed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (account, uid)
);
CREATE INDEX IF NOT EXISTS idx_mail_status_importance ON mail_messages (status, importance, received_at);

CREATE TABLE IF NOT EXISTS station_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('send_reply')),
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'done', 'failed', 'cancelled')),
  result TEXT,
  created_at TEXT NOT NULL,
  claimed_at TEXT,
  finished_at TEXT,
  claimed_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_station_jobs_status ON station_jobs (status, created_at);
