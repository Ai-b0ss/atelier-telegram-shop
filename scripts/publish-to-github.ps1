# Safe one-time publisher: creates a PUBLIC repo and pushes the current Git HEAD.
# Does not force-push, alter other repositories, or touch secrets.
param(
    [string]$Repository = 'Ai-b0ss/atelier-telegram-shop'
)
$ErrorActionPreference = 'Stop'
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { throw 'GitHub CLI (gh) is not installed.' }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'git is not installed.' }
if (-not (Test-Path '.git')) {
    throw 'Git metadata missing. Clone atelier-telegram-shop.git.bundle rather than using the source-only ZIP.'
}
& gh auth status
if ($LASTEXITCODE -ne 0) { throw 'GitHub CLI is not authenticated.' }
$login = (& gh api user --jq '.login') -join ''
if ($LASTEXITCODE -ne 0 -or $login.Trim() -ne ($Repository -split '/')[0]) {
    throw 'The authenticated GitHub account does not own the requested repository.'
}
if ((& git status --porcelain).Length -gt 0) { throw 'Uncommitted changes found; commit before publishing.' }
$check = & gh repo view $Repository --json nameWithOwner --jq '.nameWithOwner' 2>$null
if ($LASTEXITCODE -eq 0) {
    throw "Repository $Repository already exists. Refusing to overwrite it automatically."
}
& gh repo create $Repository --public --source '.' --remote origin --push
if ($LASTEXITCODE -ne 0) { throw 'Repository creation or git push failed.' }
$visibility = (& gh repo view $Repository --json isPrivate --jq '.isPrivate') -join ''
if ($LASTEXITCODE -ne 0 -or $visibility.Trim() -ne 'false') {
    throw 'Could not verify that the repository is public.'
}
Write-Output "Published public repository: https://github.com/$Repository"
