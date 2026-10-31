# Enter credentials directly into the official Cloudflare Wrangler CLI.
# No credential values are read, written, printed, logged, or sent via ChatGPT.
$ErrorActionPreference = 'Stop'
$WorkerName = 'atelier-customwear-demo-2026'
$Root = Join-Path $env:USERPROFILE 'Documents\atelier-telegram-shop\cloudflare'
if (-not (Test-Path -LiteralPath (Join-Path $Root 'wrangler.jsonc'))) {
    throw 'Cloudflare project directory not found.'
}
if (-not (Get-Command npx.cmd -ErrorAction SilentlyContinue)) {
    throw 'Node.js and npx.cmd are required.'
}
Push-Location $Root
try {
    Write-Host 'SECURE CLOUDFLARE SETUP' -ForegroundColor Cyan
    Write-Host 'The next prompts are from official Wrangler, not from ChatGPT.'
    Write-Host 'Wrangler accepts each secret directly in this local console.'
    Write-Host 'Do NOT type values into chat, shell commands, or GitHub.'
    Write-Host 'Keep the existing Telegram Windows task running until webhook cutover.'
    foreach ($Name in @('BOT_TOKEN', 'ADMIN_IDS', 'WEBHOOK_SECRET')) {
        Write-Host ''
        Write-Host ('Setting ' + $Name) -ForegroundColor Cyan
        if ($Name -eq 'BOT_TOKEN') {
            Write-Host 'Use the real BotFather token for @atelier_customwear_2611_bot.'
        } elseif ($Name -eq 'ADMIN_IDS') {
            Write-Host 'Use your numeric Telegram administrator ID.'
        } else {
            Write-Host 'Use a NEW random secret with 32+ characters (letters, numbers, - or _).'
            Write-Host 'Keep this secret for the later Telegram setWebhook step.'
        }
        & npx.cmd --yes wrangler@4.156.0 secret put $Name --name $WorkerName
        if ($LASTEXITCODE -ne 0) {
            throw ('Wrangler failed to configure ' + $Name + '; remaining secrets unchanged.')
        }
    }
    Write-Host ''
    Write-Host 'Checking only secret NAMES (not values)...'
    $SecretList = & npx.cmd --yes wrangler@4.156.0 secret list --name $WorkerName
    if ($LASTEXITCODE -ne 0) { throw 'Could not verify Cloudflare secret names.' }
    $Entries = @($SecretList | ConvertFrom-Json)
    $Found = @($Entries | ForEach-Object { $_.name })
    $Missing = @('BOT_TOKEN', 'ADMIN_IDS', 'WEBHOOK_SECRET') | Where-Object { $_ -notin $Found }
    if ($Missing.Count -gt 0) {
        throw ('Missing Cloudflare secret bindings: ' + ($Missing -join ', '))
    }
    Write-Host 'SUCCESS: Three Cloudflare secret names verified. Their VALUES were never printed.' -ForegroundColor Green
    Write-Host 'Next: configure Telegram webhook and verify live Cloudflare delivery.'
} finally {
    Pop-Location
}
