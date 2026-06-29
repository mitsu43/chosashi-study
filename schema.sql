PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS questions (
  question_id TEXT PRIMARY KEY,
  type        TEXT NOT NULL CHECK (type IN ('takuitsu', 'kijutsu')),
  year_label  TEXT NOT NULL,
  number      INTEGER NOT NULL,
  subject     TEXT,
  topic       TEXT,
  video_url   TEXT,
  pdf_url     TEXT,
  pdf_page    INTEGER,
  question_text TEXT,
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS answers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id TEXT NOT NULL,
  result      TEXT NOT NULL CHECK (result IN ('correct', 'wrong')),
  answered_at TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (question_id) REFERENCES questions(question_id)
);

CREATE TABLE IF NOT EXISTS daily_tasks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_date  TEXT NOT NULL,
  task_id    TEXT NOT NULL,
  done       INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (task_date, task_id)
);

-- PDF全体のTOC管理テーブル
-- pdf_id: 例 'takuitsu_H17-R05' など任意の識別子
-- page_no: PDFの実際のページ番号
-- question_id: そのページが対応する問題ID (NULLの場合は表紙・解説ページ等)
-- label: 表示用ラベル (例 'H17第1問', '解説')
CREATE TABLE IF NOT EXISTS pdf_pages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  pdf_id      TEXT NOT NULL,
  page_no     INTEGER NOT NULL,
  question_id TEXT,
  label       TEXT,
  UNIQUE (pdf_id, page_no),
  FOREIGN KEY (question_id) REFERENCES questions(question_id)
);

CREATE TABLE IF NOT EXISTS pdf_files (
  pdf_id      TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  drive_url   TEXT,
  total_pages INTEGER,
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_questions_type_year   ON questions(type, year_label, number);
CREATE INDEX IF NOT EXISTS idx_questions_subject     ON questions(subject);
CREATE INDEX IF NOT EXISTS idx_answers_question      ON answers(question_id);
CREATE INDEX IF NOT EXISTS idx_answers_answered_at   ON answers(answered_at);
CREATE INDEX IF NOT EXISTS idx_answers_result        ON answers(result);
CREATE INDEX IF NOT EXISTS idx_daily_tasks_date      ON daily_tasks(task_date);
CREATE INDEX IF NOT EXISTS idx_pdf_pages_pdf_id      ON pdf_pages(pdf_id);
CREATE INDEX IF NOT EXISTS idx_pdf_pages_question_id ON pdf_pages(question_id);

-- 初期データ投入 (380問: H17-R05 各20問 takuitsu)
WITH years(label) AS (
  VALUES
    ('H17'),('H18'),('H19'),('H20'),('H21'),('H22'),('H23'),('H24'),('H25'),('H26'),
    ('H27'),('H28'),('H29'),('H30'),('R01'),('R02'),('R03'),('R04'),('R05')
),
numbers(number) AS (
  VALUES (1),(2),(3),(4),(5),(6),(7),(8),(9),(10),
         (11),(12),(13),(14),(15),(16),(17),(18),(19),(20)
)
INSERT OR IGNORE INTO questions (question_id, type, year_label, number)
SELECT label || printf('%02d', number), 'takuitsu', label, number
FROM years CROSS JOIN numbers;
