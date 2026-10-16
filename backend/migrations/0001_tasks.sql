-- JARVIS durable task storage
-- Apply with: wrangler d1 migrations apply jarvisss-db --remote
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 180),
  details TEXT NOT NULL DEFAULT '' CHECK (length(details) <= 2000),
  due_at TEXT,
  priority TEXT NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('low', 'normal', 'high')),
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'done', 'cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_status_due
  ON tasks (status, due_at);

CREATE INDEX IF NOT EXISTS idx_tasks_priority_status
  ON tasks (priority, status);
