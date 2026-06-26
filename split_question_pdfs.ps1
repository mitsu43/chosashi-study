param(
  [string]$MapCsv = ".\pdf-split-map.csv",
  [string]$OutputDir = ".\split-pdfs",
  [string]$PythonExe = "C:\Users\mmats\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $MapCsv)) {
  throw "CSV not found: $MapCsv"
}

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

$script = @'
import csv
import pathlib
import sys
from pypdf import PdfReader, PdfWriter

map_csv = pathlib.Path(sys.argv[1])
output_dir = pathlib.Path(sys.argv[2])
output_dir.mkdir(parents=True, exist_ok=True)

created = []
with map_csv.open("r", encoding="utf-8-sig", newline="") as f:
    reader = csv.DictReader(f)
    for row in reader:
        question_id = (row.get("question_id") or "").strip()
        source_pdf = pathlib.Path((row.get("source_pdf") or "").strip().strip('"'))
        output_pdf = (row.get("output_pdf") or f"{question_id}.pdf").strip()
        if not question_id or not source_pdf.exists():
            continue

        start_page = int(row["start_page"])
        end_page = int(row["end_page"])
        if start_page < 1 or end_page < start_page:
            raise ValueError(f"Invalid page range for {question_id}: {start_page}-{end_page}")

        reader_pdf = PdfReader(str(source_pdf))
        writer = PdfWriter()
        for page_num in range(start_page, end_page + 1):
            if page_num > len(reader_pdf.pages):
                raise ValueError(f"{question_id}: page {page_num} exceeds {len(reader_pdf.pages)} pages")
            writer.add_page(reader_pdf.pages[page_num - 1])

        out_path = output_dir / output_pdf
        with out_path.open("wb") as out:
            writer.write(out)
        created.append(str(out_path))

print(f"created={len(created)}")
for path in created:
    print(path)
'@

$tempScript = Join-Path $env:TEMP "split_question_pdfs.py"
Set-Content -LiteralPath $tempScript -Value $script -Encoding UTF8

& $PythonExe $tempScript $MapCsv $OutputDir
