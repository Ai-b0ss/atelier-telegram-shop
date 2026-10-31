# One-time local credentials setup. Does not print the token or commit .env.
$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $project '.env'
if (Test-Path -LiteralPath $envFile) {
    throw '.env already exists. Refusing to overwrite credentials.'
}
Push-Location $project
try {
    & git check-ignore --quiet .env
    if ($LASTEXITCODE -ne 0) {
        throw 'Git does not ignore .env. Refusing to create a sensitive file.'
    }
}
finally {
    Pop-Location
}
$secure = Read-Host 'Paste Telegram BotFather token (hidden)' -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
    $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
}
finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
}
if ($token -notmatch '^[0-9]+:[A-Za-z0-9_-]{30,}$') {
    throw 'Bot token has an invalid format. Nothing was written.'
}
$ids = (Read-Host 'Enter administrator numeric Telegram ID (or comma-separated IDs)').Trim()
if ($ids -notmatch '^[1-9][0-9]*(,[1-9][0-9]*)*$') {
    throw 'ADMIN_IDS must be positive integers separated by commas.'
}
$content = "BOT_TOKEN=$token" + [Environment]::NewLine +
           "ADMIN_IDS=$ids" + [Environment]::NewLine +
           "DATABASE_PATH=data/atelier.sqlite3" + [Environment]::NewLine
$token = $null
$bytes = [Text.UTF8Encoding]::new($false).GetBytes($content)
$stream = [IO.File]::Open($envFile, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
try { $stream.Write($bytes, 0, $bytes.Length) }
finally { $stream.Dispose() }
Write-Host 'Local .env created. Token was not printed or sent to GitHub.'
Write-Host 'Start bot with: powershell -ExecutionPolicy Bypass -File scripts/start-bot.ps1'
