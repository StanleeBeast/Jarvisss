-- JARVIS Gerätesitzungen, Kopplungscodes, synchronisiertes Gedächtnis und Aktionsprotokoll.
-- Geheimnisse (Geräte-Schlüssel, Kopplungscodes) werden nur als SHA-256-Hash gespeichert.

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 60),
  refresh_hash TEXT NOT NULL,
  previous_refresh_hash TEXT,
  rotated_at TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_reason TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_refresh ON devices (refresh_hash);
CREATE INDEX IF NOT EXISTS idx_devices_previous_refresh ON devices (previous_refresh_hash);

CREATE TABLE IF NOT EXISTS pairing_codes (
  code_hash TEXT PRIMARY KEY NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL DEFAULT 'preference'
    CHECK (kind IN ('preference', 'fact', 'style', 'routine', 'project')),
  text TEXT NOT NULL CHECK (length(trim(text)) BETWEEN 1 AND 500),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories (updated_at);

-- Protokoll wichtiger Aktionen. Enthält bewusst keine Inhalte, nur Art, Zeit und Gerät.
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log (at);
