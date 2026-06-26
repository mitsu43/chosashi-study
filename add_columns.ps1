param(
  [string]$Wrangler = "C:\Program Files\nodejs\npx.cmd",
  [string]$Database = "chosashi-db"
)

$ErrorActionPreference = "Continue"

$commands = @(
  "ALTER TABLE questions ADD COLUMN subject TEXT;",
  "ALTER TABLE questions ADD COLUMN topic TEXT;",
  "ALTER TABLE questions ADD COLUMN pdf_page INTEGER;"
)

foreach ($sql in $commands) {
  Write-Host "Running: $sql"
  & $Wrangler wrangler d1 execute $Database --remote --command $sql
  if ($LASTEXITCODE -ne 0) {
    Write-Host "If this says duplicate column name, it is already applied and can be ignored." -ForegroundColor Yellow
  }
}
