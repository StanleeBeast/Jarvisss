-- JARVIS Autonomie: Protokoll aller selbstständigen Aktionen (Hinweise, vorbereitete Tage) mit offenen Vorschlägen.
-- ref verhindert Doppelungen (z. B. dieselbe Terminwarnung nur einmal).
CREATE TABLE IF NOT EXISTS autonomy_log (
  id TEXT PRIMARY KEY NOT NULL,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  proposals TEXT NOT NULL DEFAULT '[]',
  pushed INTEGER NOT NULL DEFAULT 0,
  seen INTEGER NOT NULL DEFAULT 0,
  UNIQUE (kind, ref)
);
CREATE INDEX IF NOT EXISTS idx_autonomy_at ON autonomy_log (at);
