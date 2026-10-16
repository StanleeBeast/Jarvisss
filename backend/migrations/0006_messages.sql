-- JARVIS Nachrichten-Import: gespeichert wird nur die Auswertung (mit Pseudonymen), nie der Originalchat.
CREATE TABLE IF NOT EXISTS message_imports (
  id TEXT PRIMARY KEY NOT NULL,
  label TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 120),
  source TEXT NOT NULL CHECK (source IN ('whatsapp_export', 'paste')),
  imported_at TEXT NOT NULL,
  message_count INTEGER NOT NULL,
  range_from TEXT,
  range_to TEXT,
  summary TEXT NOT NULL,
  result TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_message_imports_at ON message_imports (imported_at);

CREATE TABLE IF NOT EXISTS user_settings (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
