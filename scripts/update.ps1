<#
.SYNOPSIS
  GenQR updater for Windows: backup -> git pull -> install/build -> migrate -> restart ->
  health check. Rolls back to the previous commit and database backup if a step after the
  pull fails.

.DESCRIPTION
  genqrctl update            update if a newer commit exists on the tracked branch
  genqrctl update -Force     rebuild and restart even when already up to date

  Runs as an administrator or SYSTEM. The "GenQR Update Watcher" scheduled task (SYSTEM)
  starts it every minute with -FromUi; it exits at once unless an admin clicked "Update now".

  Two stages, like the Linux updater: stage 1 (this file as it was before the pull) fetches,
  backs up and fast-forwards, then runs the newly pulled update.ps1 with -Continue.
#>
param(
  [switch]$Force,
  [switch]$FromUi,
  [switch]$Continue
)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'genqr.psm1') -Force
# Admin-run tools load database drivers from an admin-only folder (bin\drivers), never from
# drivers\, which the service account can write.
$env:GENQR_DRIVERS_DIR = Join-Path (Split-Path -Parent $PSScriptRoot) 'bin\drivers'

$Root = Get-GenQRRoot
$Service = Get-GenQRServiceName
$Data = Join-Path $Root 'data'
$Logs = Join-Path $Root 'logs'
$Request = Join-Path $Data 'update.request'
$StatusFile = Join-Path $Data 'update-status.json'
$LogFile = Join-Path $Logs 'update.log'

# Scheduled-task polling: nothing requested, nothing to do.
if ($FromUi -and -not $Continue -and -not (Test-Path $Request)) { exit 0 }
Assert-GenQRAdmin

# State handed from stage 1 to stage 2.
$OldCommit = $env:GENQR_UPDATE_OLD
$NewCommit = $env:GENQR_UPDATE_NEW
$Backup = $env:GENQR_UPDATE_BACKUP
$RequestedBy = $env:GENQR_UPDATE_BY
if (-not $RequestedBy) { $RequestedBy = "cli:$env:USERNAME" }

function Log([string]$Message) {
  $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
  Write-Host $line
  Add-Content -Path $LogFile -Value $line
}

function Write-Status([string]$State, [string]$Message) {
  $status = [ordered]@{
    state = $State; message = $Message; requestedBy = $RequestedBy
    fromCommit = $OldCommit; toCommit = $NewCommit; at = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  }
  $tmp = "$StatusFile.tmp"
  $status | ConvertTo-Json -Compress | Set-Content -Path $tmp -Encoding UTF8
  Move-Item -Path $tmp -Destination $StatusFile -Force
}

function Git { $gitArgs = $args; Invoke-GenQRNative -What "git $($gitArgs -join ' ')" -LogFile $LogFile -Command { & git -C $Root @gitArgs } }
function Git-Output { (& git -C $Root @args 2>$null | Out-String).Trim() }
function Cli([string]$What) { $cliArgs = $args; Invoke-GenQRNative -What $What -LogFile $LogFile -Command { Invoke-GenQRCli @cliArgs } }

function Build-App {
  Push-Location $Root
  try {
    Invoke-GenQRNative -What 'npm ci' -LogFile $LogFile -Command { & npm ci --include=dev --no-audit --no-fund --loglevel=error }
    Invoke-GenQRNative -What 'npm run build' -LogFile $LogFile -Command { & npm run build --silent }
  } finally { Pop-Location }
}

function Get-DbClient {
  try { return (Get-Content (Join-Path $Root 'config\database.json') -Raw | ConvertFrom-Json).client } catch { return 'sqlite' }
}

function Get-SqliteFile {
  $name = 'data\genqr.db'
  try { $c = (Get-Content (Join-Path $Root 'config\database.json') -Raw | ConvertFrom-Json).connection.filename; if ($c) { $name = $c } } catch { }
  $full = [IO.Path]::GetFullPath((Join-Path $Root $name))
  # The config is writable by the service account: never restore over a file outside data\.
  if ((Split-Path -Parent $full) -ne [IO.Path]::GetFullPath($Data)) { throw "Refusing to restore to $full (outside the data folder)." }
  return $full
}

function Invoke-Rollback([string]$Reason) {
  Log "ERROR: $Reason"
  Log "Rolling back to $($OldCommit.Substring(0,7))"
  Write-Status 'running' "Rolling back: $Reason"
  Stop-Service $Service -ErrorAction SilentlyContinue
  try {
    if ($script:Migrated -and -not (Test-Path (Join-Path $Backup 'genqr.db'))) { Cli 'Undoing migrations' migrate-rollback }
  } catch { Log "Undoing the migrations failed: $_" }
  try { Git reset --hard $OldCommit; Build-App } catch { Log "Rebuilding the previous version failed: $_" }
  $dump = Join-Path $Backup 'genqr-dump.json.gz'
  if (Test-Path $dump) {
    Log "Restoring database contents from $dump"
    try { Cli 'Restoring the dump' restore $dump } catch { Log "Restoring the dump failed: $_" }
  }
  $dbBackup = Join-Path $Backup 'genqr.db'
  if (Test-Path $dbBackup) {
    $dbFile = Get-SqliteFile
    Log "Restoring database from $dbBackup"
    Remove-Item "$dbFile-wal", "$dbFile-shm" -ErrorAction SilentlyContinue
    Copy-Item $dbBackup $dbFile -Force
  }
  Start-Service $Service -ErrorAction SilentlyContinue
  if (Wait-GenQRHealthy -Commit $OldCommit) {
    Write-Status 'failed' "$Reason. Rolled back to $($OldCommit.Substring(0,7))."
  } else {
    Write-Status 'failed' "$Reason. ROLLBACK ALSO FAILED - check logs\service.log"
  }
  exit 1
}

# -----------------------------------------------------------------------------------
# Stage 2: runs from the newly pulled code.
# -----------------------------------------------------------------------------------
if ($Continue) {
  if (-not $OldCommit -or -not $NewCommit) { throw '-Continue is internal to the updater.' }
  $script:Migrated = $false
  try {
    Log 'Installing dependencies and building'
    Write-Status 'running' 'Building'
    Build-App

    Log 'Checking the database driver'
    Cli 'Installing the database driver' install-driver

    Log 'Applying database migrations'
    Write-Status 'running' 'Migrating database'
    $out = (Invoke-GenQRCli migrate 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0) { throw "Migrations failed: $out" }
    Log $out.Trim()
    if ($out -match 'Applied migrations') { $script:Migrated = $true }

    Log "Restarting $Service"
    Write-Status 'running' 'Restarting'
    Restart-Service $Service
  } catch {
    Invoke-Rollback "Update step failed: $($_.Exception.Message)"
  }
  if (-not (Wait-GenQRHealthy -Commit $NewCommit)) { Invoke-Rollback 'The new version did not become healthy' }

  $done = "Updated to $($NewCommit.Substring(0,7))"
  & git -C $Root diff --quiet $OldCommit $NewCommit -- scripts/install.ps1 2>$null
  if ($LASTEXITCODE -ne 0) {
    $done += '. The installer changed: re-run install.ps1 to apply service changes.'
    Log 'NOTE: this version changes install.ps1. Re-run it (as administrator) to apply service and task changes.'
  }
  Log "Update complete: now on $($NewCommit.Substring(0,7))"
  Write-Status 'success' $done

  # Keep the 10 most recent backups.
  Get-ChildItem (Join-Path $Root 'backups') -Directory | Sort-Object LastWriteTime -Descending | Select-Object -Skip 10 | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  exit 0
}

# -----------------------------------------------------------------------------------
# Stage 1: check, back up, pull.
# -----------------------------------------------------------------------------------
foreach ($d in $Data, $Logs, (Join-Path $Root 'backups')) { New-Item -ItemType Directory -Force -Path $d | Out-Null }

# Only one update at a time: an exclusively opened lock file, held until we exit.
try {
  $lock = [IO.File]::Open((Join-Path $Data 'update.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
} catch {
  if ($FromUi) { exit 0 }
  throw 'Another update is already running.'
}

try {
  if (Test-Path $Request) {
    try { $RequestedBy = ((Get-Content $Request -Raw | ConvertFrom-Json).requestedBy -replace '[^A-Za-z0-9._:@-]', '') } catch { }
    Remove-Item $Request -Force
  }

  if (Test-Path $LogFile) { Move-Item $LogFile "$LogFile.1" -Force }
  New-Item -ItemType File -Force -Path $LogFile | Out-Null

  Log "GenQR update started by $RequestedBy"
  $OldCommit = Git-Output rev-parse HEAD
  $branch = Git-Output rev-parse --abbrev-ref HEAD
  Write-Status 'running' 'Checking for updates'

  if (Git-Output status --porcelain --untracked-files=no) {
    Log 'ERROR: tracked files were modified locally; refusing to update.'
    Write-Status 'failed' "Tracked files were modified locally in $Root; refusing to update."
    exit 1
  }

  Log "Fetching origin/$branch"
  try { Git fetch --prune origin $branch } catch { Write-Status 'failed' 'Could not fetch from the git remote'; throw }
  $NewCommit = Git-Output rev-parse "origin/$branch"

  if ($NewCommit -eq $OldCommit -and -not $Force) {
    Log "Already up to date ($($OldCommit.Substring(0,7)))"
    Write-Status 'up-to-date' 'Already on the latest version'
    exit 0
  }
  Log "Updating $($OldCommit.Substring(0,7)) -> $($NewCommit.Substring(0,7))"

  $Backup = Join-Path $Root ("backups\{0}-{1}" -f (Get-Date -Format 'yyyyMMdd-HHmmss'), $OldCommit.Substring(0, 7))
  Log "Backing up configuration and database to $Backup"
  Write-Status 'running' 'Backing up'
  New-Item -ItemType Directory -Force -Path $Backup | Out-Null
  Copy-Item (Join-Path $Root '.env') $Backup -ErrorAction SilentlyContinue
  Copy-Item (Join-Path $Root 'config') $Backup -Recurse -ErrorAction SilentlyContinue
  if ((Get-DbClient) -eq 'sqlite') { Cli 'Backing up the database' backup (Join-Path $Backup 'genqr.db') }
  else { Cli 'Backing up the database' backup (Join-Path $Backup 'genqr-dump.json.gz') }

  Log 'Applying new code'
  Write-Status 'running' "Installing $($NewCommit.Substring(0,7))"
  try { Git merge --ff-only "origin/$branch" } catch { Invoke-Rollback "Applying the new code failed: $($_.Exception.Message)" }

  # Hand over to the update.ps1 that was just pulled (the lock stays held by this process).
  $env:GENQR_UPDATE_OLD = $OldCommit
  $env:GENQR_UPDATE_NEW = $NewCommit
  $env:GENQR_UPDATE_BACKUP = $Backup
  $env:GENQR_UPDATE_BY = $RequestedBy
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'scripts\update.ps1') -Continue
  exit $LASTEXITCODE
} catch {
  Log "ERROR: $($_.Exception.Message)"
  Write-Status 'failed' $_.Exception.Message
  exit 1
} finally {
  $lock.Dispose()
}
