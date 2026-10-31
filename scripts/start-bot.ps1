# Launch the Telegram shop with local .env. Never print authentication tokens.
$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$python = Join-Path $project '.venv\Scripts\python.exe'
$envFile = Join-Path $project '.env'
if (-not (Test-Path -LiteralPath $python)) {
    throw 'Python virtual environment is missing. Run: python -m venv .venv; .\.venv\Scripts\python.exe -m pip install -r requirements.txt'
}
if (-not (Test-Path -LiteralPath $envFile)) {
    throw 'Local .env file is missing. Use scripts/setup-bot.ps1 first.'
}
Push-Location $project
try {
    & $python -m atelier
    if ($LASTEXITCODE -ne 0) { throw "Bot stopped with exit code $LASTEXITCODE" }
}
finally {
    Pop-Location
}
