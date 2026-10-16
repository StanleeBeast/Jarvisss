-- JARVIS Tagesplaner: pro Tag nur die bestätigten Änderungen (z. B. Block fällt aus, mehr Freizeit).
-- Der Plan selbst wird bei jedem Abruf aus Aufgaben, Vorlieben (user_settings 'planner_prefs') und Routinen berechnet.
CREATE TABLE IF NOT EXISTS day_plans (
  date TEXT PRIMARY KEY NOT NULL,
  overrides TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);
