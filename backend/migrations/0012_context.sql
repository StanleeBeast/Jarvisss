-- JARVIS Kontext vom iPhone/iPad (Apple-Kurzbefehle): jeweils der letzte Stand pro Art (Ort, Fokus, Akku, Gesundheit, Notiz).
CREATE TABLE IF NOT EXISTS context_state (
  type TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  device TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
