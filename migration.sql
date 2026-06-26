CREATE TABLE IF NOT EXISTS pdf_files (
  pdf_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  drive_url TEXT,
  total_pages INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pdf_pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pdf_id TEXT NOT NULL,
  page_no INTEGER NOT NULL,
  question_id TEXT,
  label TEXT,
  UNIQUE (pdf_id, page_no),
  FOREIGN KEY (question_id) REFERENCES questions(question_id)
);

CREATE INDEX IF NOT EXISTS idx_questions_subject ON questions(subject);
CREATE INDEX IF NOT EXISTS idx_pdf_pages_pdf_id ON pdf_pages(pdf_id);
CREATE INDEX IF NOT EXISTS idx_pdf_pages_question_id ON pdf_pages(question_id);
