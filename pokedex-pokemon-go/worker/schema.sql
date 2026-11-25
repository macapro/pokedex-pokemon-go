PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS pokemon (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  national_number INTEGER NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  korean_name TEXT NOT NULL,
  english_name TEXT DEFAULT '',
  form_name TEXT DEFAULT '기본폼',
  generation INTEGER,
  region TEXT DEFAULT '',
  image_url TEXT DEFAULT '',
  type1 TEXT DEFAULT '',
  type2 TEXT DEFAULT '',
  description TEXT DEFAULT '',
  is_published INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pokemon_number ON pokemon(national_number);
CREATE INDEX IF NOT EXISTS idx_pokemon_name ON pokemon(korean_name);
CREATE INDEX IF NOT EXISTS idx_pokemon_published ON pokemon(is_published);

CREATE TABLE IF NOT EXISTS type_catalog (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name_ko TEXT NOT NULL UNIQUE,
  name_en TEXT DEFAULT '',
  color TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS moves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name_ko TEXT NOT NULL,
  name_en TEXT DEFAULT '',
  move_type TEXT DEFAULT '',
  category TEXT NOT NULL DEFAULT 'GO_FAST',
  power INTEGER,
  energy INTEGER,
  duration_ms INTEGER,
  description TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS pokemon_moves (
  pokemon_id INTEGER NOT NULL REFERENCES pokemon(id) ON DELETE CASCADE,
  move_id INTEGER NOT NULL REFERENCES moves(id) ON DELETE CASCADE,
  game_scope TEXT NOT NULL,
  learn_method TEXT DEFAULT '',
  PRIMARY KEY (pokemon_id, move_id, game_scope)
);

CREATE TABLE IF NOT EXISTS evolutions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_pokemon_id INTEGER NOT NULL REFERENCES pokemon(id) ON DELETE CASCADE,
  to_pokemon_id INTEGER NOT NULL REFERENCES pokemon(id) ON DELETE CASCADE,
  condition_text TEXT DEFAULT ''
);
