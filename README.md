# 土地家屋調査士 合格アプリ

Cloudflare Workers + D1 で動く、択一過去問の毎日ノルマ管理アプリです。

## ファイル

- `schema.sql`: D1テーブルと初期問題データ
- `worker.js`: API
- `wrangler.toml`: Cloudflare設定
- `index.html`: スマホ向け画面
- `.github/workflows/deploy.yml`: GitHub Actionsデプロイ

## 初回セットアップ

1. CloudflareでD1を作成

```bash
wrangler d1 create chosashi-db
```

2. 表示された `database_id` を `wrangler.toml` に入れる

```toml
database_id = "ここにD1のID"
```

3. D1にスキーマと初期データを投入

```bash
wrangler d1 execute chosashi-db --file=schema.sql
```

4. Workerをデプロイ

```bash
wrangler deploy
```

5. `index.html` を開き、計画タブにWorkers URLを保存

例:

```text
https://chosashi-study.xxxxx.workers.dev
```

## API確認

```bash
curl https://chosashi-study.xxxxx.workers.dev/api/stats
```

## 動画・PDFの紐づけ

`questions.video_url` と `questions.pdf_url` にGoogle DriveのURLまたはファイルIDを入れます。

- 動画: アプリ内のモーダルで再生
- PDF: 別タブで表示

まずはURL未登録でも、問題ID、正誤記録、誤答復習、統計は使えます。
