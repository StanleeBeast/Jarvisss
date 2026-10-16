-- JARVIS Nutzungszähler pro Tag (Europe/Berlin) für Tageslimits und Kostenübersicht.
CREATE TABLE IF NOT EXISTS usage_daily (
  day TEXT PRIMARY KEY NOT NULL,
  chat_requests INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  tts_requests INTEGER NOT NULL DEFAULT 0,
  tts_chars INTEGER NOT NULL DEFAULT 0
);
