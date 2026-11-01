$ErrorActionPreference='Stop'
$entry=Join-Path $PSScriptRoot 'backup-at-home.ps1'
$arg='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$entry+'" -Mode Backup'
$action=New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument $arg
$trigger=New-ScheduledTaskTrigger -Daily -At '08:30'
$settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 10)
$principal=New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'Atelier-D1-Encrypted-Daily' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Get-ScheduledTask -TaskName 'Atelier-D1-Encrypted-Daily' | Select-Object TaskName,State
