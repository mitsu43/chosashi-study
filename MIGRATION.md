# 本番D1マイグレーション手順

## 前提
- `wrangler.toml` の `database_id` が正しく設定済みであること
- `/api/stats` で `total_questions: 380` が確認できていること

## Step 1: D1 にカラム追加（既存380問に影響なし）

```sh
# subject / topic カラム追加
wrangler d1 execute chosashi-db --remote --command "ALTER TABLE questions ADD COLUMN subject TEXT;"
wrangler d1 execute chosashi-db --remote --command "ALTER TABLE questions ADD COLUMN topic TEXT;"

# PDF関連カラム追加
wrangler d1 execute chosashi-db --remote --command "ALTER TABLE questions ADD COLUMN pdf_page INTEGER;"

# pdf_files テーブル作成
wrangler d1 execute chosashi-db --remote --command "
CREATE TABLE IF NOT EXISTS pdf_files (
  pdf_id      TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  drive_url   TEXT,
  total_pages INTEGER,
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);"

# pdf_pages テーブル作成
wrangler d1 execute chosashi-db --remote --command "
CREATE TABLE IF NOT EXISTS pdf_pages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  pdf_id      TEXT NOT NULL,
  page_no     INTEGER NOT NULL,
  question_id TEXT,
  label       TEXT,
  UNIQUE (pdf_id, page_no),
  FOREIGN KEY (question_id) REFERENCES questions(question_id)
);"

# インデックス追加
wrangler d1 execute chosashi-db --remote --command "CREATE INDEX IF NOT EXISTS idx_questions_subject ON questions(subject);"
wrangler d1 execute chosashi-db --remote --command "CREATE INDEX IF NOT EXISTS idx_pdf_pages_pdf_id ON pdf_pages(pdf_id);"
wrangler d1 execute chosashi-db --remote --command "CREATE INDEX IF NOT EXISTS idx_pdf_pages_question_id ON pdf_pages(question_id);"
```

## Step 2: Worker をデプロイ

```sh
wrangler deploy
```

## Step 3: 動作確認

```sh
# 既存APIが正常か
curl https://chosashi-study.m-matsugane.workers.dev/api/stats

# 新APIが応答するか
curl https://chosashi-study.m-matsugane.workers.dev/api/subjects

# 管理画面が表示されるか
open https://chosashi-study.m-matsugane.workers.dev/admin
```

## Step 4 以降: 管理画面での運用

1. `/admin` → 「問題管理」タブで各問題の科目・論点・PDF・動画を登録
2. `/admin` → 「PDF管理」タブでPDFファイル登録 → ページ対応表をCSVで一括登録
   - CSV形式: `ページ番号,問題ID,ラベル`
   - 例: `1,H1701,H17第1問`
   - 表紙や解説ページは問題IDなし: `21,,表紙`
