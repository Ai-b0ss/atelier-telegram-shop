# Install per-user Windows Task Scheduler startup. Never reads or displays the bot token.
# OnLogon requires the owner to sign into Windows; this is NOT a 24/7 VPS.
$ErrorActionPreference = 'Stop'
$taskName = 'AtelierTelegramDemo'
$project = Split-Path -Parent $PSScriptRoot
$python = Join-Path $project '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) { throw 'Project venv not found' }
if (-not (Test-Path -LiteralPath (Join-Path $project '.env'))) { throw 'Local bot .env missing' }
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
    $action = @($existing.Actions)[0]
    if ($action.Execute -ne $python -or $action.Arguments -ne '-m atelier.supervisor') {
        throw 'A different task with this name exists; refusing to overwrite it.'
    }
    Write-Output 'Autostart task already installed'
} else {
    $action = New-ScheduledTaskAction -Execute $python -Argument '-m atelier.supervisor' -WorkingDirectory $project
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Run atelier demo bot under a supervised local Windows process' | Out-Null
    Write-Output 'Autostart task installed'
}
Write-Output ('TaskName=' + $taskName)
Write-Output ('LogonUser=' + $user)
Write-Output 'The app will start automatically after sign-in. Use Start-ScheduledTask to start now.'
