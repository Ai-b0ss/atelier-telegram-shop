param(
  [string]$DatabaseName = "atelier-customwear-demo-2026"
)
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$project = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$cloudflare = Join-Path $project "cloudflare"
$targetDir = Join-Path $project "backups"
New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
$stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
$temporary = Join-Path $env:TEMP ("atelier-d1-" + [guid]::NewGuid().ToString("N") + ".sql")
$final = Join-Path $targetDir ("atelier-D1-" + $stamp + "-" + [guid]::NewGuid().ToString("N").Substring(0,8) + ".sql.dpapi")
$backupCompleted=$false
try {
  Set-Location -LiteralPath $cloudflare
  & npx.cmd --yes wrangler@4.156.0 d1 export $DatabaseName --remote --output $temporary | Out-Null
  if($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $temporary)){throw "D1 export failed"}
  $python = Join-Path $project ".venv\Scripts\python.exe"
  if(-not (Test-Path -LiteralPath $python)){ $python="python" }
  & $python (Join-Path $PSScriptRoot "verify-d1-export.py") $temporary
  if($LASTEXITCODE -ne 0){throw "Export failed SQLite restore verification"}
  $raw = [IO.File]::ReadAllBytes($temporary)
  if($raw.Length -lt 100 -or -not [Text.Encoding]::UTF8.GetString($raw).Contains("CREATE TABLE")){
    throw "Invalid or incomplete D1 SQL export"
  }
  Add-Type -AssemblyName System.Security
  $scope = [Security.Cryptography.DataProtectionScope]::CurrentUser
  $encrypted = [Security.Cryptography.ProtectedData]::Protect($raw,$null,$scope)
  [IO.File]::WriteAllBytes($final,$encrypted)
  $roundtrip = [Security.Cryptography.ProtectedData]::Unprotect(
    [IO.File]::ReadAllBytes($final),$null,$scope
  )
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $a=[Convert]::ToBase64String($sha.ComputeHash($raw))
    $b=[Convert]::ToBase64String($sha.ComputeHash($roundtrip))
    if($a -ne $b){throw "Backup roundtrip checksum mismatch"}
  } finally { $sha.Dispose() }
  $raw=[byte[]]::new(0)
  $roundtrip=[byte[]]::new(0)
  Write-Output "CLOUDFLARE_D1_BACKUP_CREATED"
  Write-Output ("ENCRYPTED_FILE_SIZE=" + (Get-Item -LiteralPath $final).Length)
  Write-Output "DPAPI_CURRENT_USER_ROUNDTRIP_OK"
  Write-Output "RESTORABLE_ONLY_ON_THIS_WINDOWS_USER_ACCOUNT"
  $backupCompleted=$true
} finally {
  if(-not $backupCompleted -and (Test-Path -LiteralPath $final)){
    Remove-Item -LiteralPath $final -Force -ErrorAction SilentlyContinue
  }
  if(Test-Path -LiteralPath $temporary) {
    Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
  }
}
