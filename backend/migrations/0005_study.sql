-- JARVIS Lernassistent: Lernsets aus eigenen Unterlagen, Karteikarten und Quizfragen mit Lernkartei-Fortschritt.
CREATE TABLE IF NOT EXISTS study_sets (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 120),
  topic TEXT NOT NULL DEFAULT '',
  source_name TEXT NOT NULL DEFAULT '',
  source_kind TEXT NOT NULL DEFAULT 'text' CHECK (source_kind IN ('pdf', 'text')),
  read_mode TEXT NOT NULL DEFAULT 'text' CHECK (read_mode IN ('text', 'images', 'mixed')),
  summary TEXT NOT NULL,
  unclear TEXT NOT NULL DEFAULT '[]',
  additions TEXT NOT NULL DEFAULT '[]',
  track_progress INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS study_cards (
  id TEXT PRIMARY KEY NOT NULL,
  set_id TEXT NOT NULL REFERENCES study_sets(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('flashcard', 'quiz')),
  position INTEGER NOT NULL DEFAULT 0,
  prompt TEXT NOT NULL,
  answer TEXT NOT NULL,
  options TEXT,
  correct_index INTEGER,
  explanation TEXT NOT NULL DEFAULT '',
  origin TEXT NOT NULL DEFAULT 'notes' CHECK (origin IN ('notes', 'addition')),
  box INTEGER NOT NULL DEFAULT 1 CHECK (box BETWEEN 1 AND 5),
  due_at TEXT,
  correct_count INTEGER NOT NULL DEFAULT 0,
  wrong_count INTEGER NOT NULL DEFAULT 0,
  marked INTEGER NOT NULL DEFAULT 0,
  last_reviewed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_study_cards_set ON study_cards (set_id, kind, position);
