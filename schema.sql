PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS questions (
  question_id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('takuitsu', 'kijutsu')),
  year_label TEXT NOT NULL,
  number INTEGER NOT NULL,
  video_url TEXT,
  pdf_url TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('correct', 'wrong')),
  answered_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (question_id) REFERENCES questions(question_id)
);

CREATE TABLE IF NOT EXISTS daily_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_date TEXT NOT NULL,
  task_id TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (task_date, task_id)
);

CREATE INDEX IF NOT EXISTS idx_questions_type_year ON questions(type, year_label, number);
CREATE INDEX IF NOT EXISTS idx_answers_question ON answers(question_id);
CREATE INDEX IF NOT EXISTS idx_answers_answered_at ON answers(answered_at);
CREATE INDEX IF NOT EXISTS idx_answers_result ON answers(result);
CREATE INDEX IF NOT EXISTS idx_daily_tasks_date ON daily_tasks(task_date);

WITH years(label, era_order, era_year) AS (
  VALUES
    ('H17', 1, 17), ('H18', 1, 18), ('H19', 1, 19), ('H20', 1, 20),
    ('H21', 1, 21), ('H22', 1, 22), ('H23', 1, 23), ('H24', 1, 24),
    ('H25', 1, 25), ('H26', 1, 26), ('H27', 1, 27), ('H28', 1, 28),
    ('H29', 1, 29), ('H30', 1, 30), ('R01', 2, 1), ('R02', 2, 2),
    ('R03', 2, 3), ('R04', 2, 4), ('R05', 2, 5)
),
numbers(number) AS (
  VALUES (1), (2), (3), (4), (5), (6), (7), (8), (9), (10),
         (11), (12), (13), (14), (15), (16), (17), (18), (19), (20)
)
INSERT OR IGNORE INTO questions (question_id, type, year_label, number)
SELECT label || printf('%02d', number), 'takuitsu', label, number
FROM years
CROSS JOIN numbers;
