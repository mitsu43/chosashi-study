# 問題別PDF分割手順

全体PDFをそのまま問題に登録すると、開いた後に探す手間が残ります。
問題ごとに必要ページだけ分割してから登録してください。

## 1. 対応表を書く

`pdf-split-map.csv` を編集します。

```csv
question_id,subject,topic,source_pdf,start_page,end_page,output_pdf
H1701,民法,代理,C:\教材\択一過去問.pdf,12,13,H1701_民法_代理.pdf
H1702,不動産登記法,所有権保存登記,C:\教材\択一過去問.pdf,14,16,H1702_不登法_所有権保存.pdf
```

- `question_id`: アプリ上の問題ID
- `subject`: 科目
- `topic`: 論点
- `source_pdf`: 元PDFの場所
- `start_page`: 開始ページ
- `end_page`: 終了ページ
- `output_pdf`: 分割後のファイル名

## 2. 分割する

PowerShellで、このフォルダに移動して実行します。

```powershell
.\split_question_pdfs.ps1
```

分割PDFは `split-pdfs` フォルダにできます。

## 3. Google Driveに置く

`split-pdfs` のPDFをGoogle Driveにアップロードします。

## 4. アプリに登録

アプリで該当問題の `PDFを登録` を押し、Google Driveの共有URLを貼ります。

科目・論点も `科目・論点を登録` から入れます。
