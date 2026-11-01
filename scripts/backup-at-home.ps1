[CmdletBinding()]
param([ValidateSet('Backup','SelfTest')][string]$Mode='Backup',
[string]$PrimaryDestination="$env:USERPROFILE\OneDrive\Atelier-D1-Encrypted-Backups",
[string]$SecondaryDestination="K:\Atelier-D1-Encrypted-Backups")
$ErrorActionPreference='Stop'
$repo=Split-Path -Parent $PSScriptRoot
$state=Join-Path $env:LOCALAPPDATA 'Atelier-D1-Backup'
New-Item -ItemType Directory -Force -Path $state | Out-Null
$log=Join-Path $state 'last-status.json'
function Status([string]$s,[string]$m) {
  @{time=(Get-Date).ToUniversalTime().ToString('o');state=$s;message=$m} | ConvertTo-Json -Compress | Set-Content -Path $log -Encoding UTF8
  Write-Output ($s+': '+$m)
}
function CopyVerified([string]$src,[string]$dest) {
  if([string]::IsNullOrWhiteSpace($dest)){throw 'Missing destination'}
  New-Item -ItemType Directory -Path $dest -Force | Out-Null
  $target=Join-Path $dest ([IO.Path]::GetFileName($src))
  $part=$target+'.partial'
  try {
    Copy-Item -LiteralPath $src -Destination $part -Force
    if((Get-FileHash -Algorithm SHA256 -LiteralPath $src).Hash -ne (Get-FileHash -Algorithm SHA256 -LiteralPath $part).Hash){throw 'Copy checksum mismatch'}
    Move-Item -LiteralPath $part -Destination $target -Force
  } finally {if(Test-Path $part){Remove-Item -LiteralPath $part -Force}}
  if((Get-FileHash -Algorithm SHA256 -LiteralPath $src).Hash -ne (Get-FileHash -Algorithm SHA256 -LiteralPath $target).Hash){throw 'Final checksum mismatch'}
  return $target
}
try {
  if($Mode -eq 'Backup') {
    Push-Location $repo
    try{
      $prevErrorPreference=$ErrorActionPreference; $ErrorActionPreference='Continue'
      try{$output=@(& node (Join-Path $repo 'scripts\d1-backup.mjs') backup 2>&1)}finally{$ErrorActionPreference=$prevErrorPreference}
      if($LASTEXITCODE -ne 0){throw 'D1 export / encryption / validation failed'}
      $line=@($output|ForEach-Object {[string]$_}|Where-Object {$_ -match '^BACKUP_CREATED='}|Select-Object -Last 1)
      if($line.Count -ne 1 -or -not (($output -join ';') -match 'ROUNDTRIP_OK')){throw 'Verified backup marker missing'}
      $src=([string]$line[0]).Substring(15).Trim()
      if(-not (Test-Path -LiteralPath $src -PathType Leaf) -or -not $src.EndsWith('.sql.atlbk')){throw 'Archive missing'}
    }finally{Pop-Location}
  }else{
    $src=Join-Path $state ('synthetic-'+[guid]::NewGuid().ToString('N')+'.sql.atlbk')
    $bytes=New-Object byte[] 64
    $rng=[Security.Cryptography.RandomNumberGenerator]::Create();$rng.GetBytes($bytes);$rng.Dispose()
    [IO.File]::WriteAllBytes($src,$bytes)
  }
  $first=CopyVerified $src $PrimaryDestination
  $second=CopyVerified $src $SecondaryDestination
  if($Mode -eq 'SelfTest'){
    Remove-Item -LiteralPath $first,$second,$src -Force
    Status 'SELFTEST_OK' 'Two SHA256-verified destination writes (synthetic data)'
    exit 0
  }
  if(-not (Get-Process -Name OneDrive -ErrorAction SilentlyContinue)){
    Status 'PARTIAL_LOCAL' 'Verified encrypted archives in both folders; OneDrive synchronization is NOT running'
    exit 2
  }
  Status 'COPIES_VERIFIED_REMOTE_UNCONFIRMED' 'Both encrypted copies verified locally; remote synchronization unverified'
  exit 0
}catch {
  Status 'BACKUP_FAILED' ($_.Exception.GetType().Name+': '+$_.Exception.Message.Replace($env:USERPROFILE,'%USERPROFILE%'))
  exit 1
}
