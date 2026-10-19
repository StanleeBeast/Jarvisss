-- JARVIS Kostenzähler: geschätzte OpenAI-Kosten pro Tag in Mikro-Dollar (1 $ = 1 000 000) für die Monatsgrenze.
ALTER TABLE usage_daily ADD COLUMN cost_micros INTEGER NOT NULL DEFAULT 0;
