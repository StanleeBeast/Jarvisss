-- JARVIS Automatisierungen: Push-Abos, Routinen, geplante Benachrichtigungen, Briefings, Serverschlüssel.

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY NOT NULL,
  device_id TEXT,
  label TEXT NOT NULL DEFAULT 'Gerät',
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_success_at TEXT,
  failures INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);

-- Routinen: morning_briefing, task_reminders, arrival. config ist JSON, Zeiten sind lokale Zeiten in timezone.
CREATE TABLE IF NOT EXISTS routines (
  kind TEXT PRIMARY KEY NOT NULL CHECK (kind IN ('morning_briefing', 'task_reminders', 'arrival')),
  enabled INTEGER NOT NULL DEFAULT 0,
  config TEXT NOT NULL DEFAULT '{}',
  timezone TEXT NOT NULL DEFAULT 'Europe/Berlin',
  last_run_day TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scheduled_notifications (
  id TEXT PRIMARY KEY NOT NULL,
  send_at TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT './',
  kind TEXT NOT NULL DEFAULT 'custom',
  created_at TEXT NOT NULL,
  sent_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'missed', 'cancelled'))
);
CREATE INDEX IF NOT EXISTS idx_scheduled_pending ON scheduled_notifications (status, send_at);

CREATE TABLE IF NOT EXISTS briefings (
  id TEXT PRIMARY KEY NOT NULL,
  created_at TEXT NOT NULL,
  content TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS server_keys (
  name TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  created_at TEXT NOT NULL
);

ALTER TABLE tasks ADD COLUMN reminder_sent_at TEXT;
