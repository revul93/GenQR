<#
.SYNOPSIS
  genqrctl for Windows: control the GenQR service. install.ps1 puts a genqrctl.cmd wrapper
  on the machine PATH, so it runs as `genqrctl <command>` from any prompt.
#>
param(
  [Parameter(Position = 0)][string]$Command = 'help',
  [Parameter(Position = 1, ValueFromRemainingArguments = $true)][string[]]$Rest
)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'genqr.psm1') -Force
# Admin-run tools load database drivers from an admin-only folder (bin\drivers), never from
# drivers\, which the service account can write.
$env:GENQR_DRIVERS_DIR = Join-Path (Split-Path -Parent $PSScriptRoot) 'bin\drivers'
$Root = Get-GenQRRoot
$Service = Get-GenQRServiceName
if (-not $Rest) { $Rest = @() }

function Show-Usage {
  @"
Usage: genqrctl <command> [options]

Service
  status                       Service state, version, database and health
  start | stop | restart       Control the service
  logs [-f]                    Show (or follow) the service log

Maintenance
  update [-Force]              Pull the latest version from GitHub and restart
  reset-password <username>    Set a new password for a local user
        [--unlock] [--must-change] [--password-stdin]
  setup-token                  Show the first-launch setup token
  backup <file>                Back up the database (SQLite: .db copy; any engine: .json.gz dump)
  restore <file>               Replace all data with a backup (stops and restarts the service)
  migrate                      Apply database migrations

Database
  db-status                    Engine in use, driver, row counts
  db-switch --client <mysql|pg|sqlite> --host H --port P --database D --user U [--ssl]
                               Copy everything to another empty database and switch to it
  install-driver               Install the driver for the configured database
  version                      Show version and commit

Installed in: $Root
"@
}

function Show-Status {
  $svc = Get-Service $Service -ErrorAction SilentlyContinue
  $health = Get-GenQRHealth
  $state = if ($svc) { $svc.Status } else { 'not installed' }
  $healthText = if ($health) { 'OK' } else { 'NOT RESPONDING' }
  Write-Host "Service:  $Service $state"
  Write-Host ("Health:   {0} (http://127.0.0.1:{1}/api/health)" -f $healthText, (Get-GenQRPort))
  $lines = @(Invoke-GenQRCli version)
  if ($lines.Count) {
    Write-Host "Version:  $($lines[0])"
    $lines | Select-Object -Skip 1 | ForEach-Object { Write-Host "          $_" }
  }
  if (-not $health) { exit 1 }
}

switch ($Command) {
  'status' { Show-Status }
  { $_ -in 'start', 'stop', 'restart' } {
    Assert-GenQRAdmin
    switch ($Command) {
      'start' { Start-Service $Service }
      'stop' { Stop-Service $Service }
      'restart' { Restart-Service $Service }
    }
    if ($Command -ne 'stop' -and -not (Wait-GenQRHealthy)) { throw 'Service did not become healthy; see: genqrctl logs' }
    Show-Status
  }
  'logs' {
    $log = Join-Path $Root 'logs\service.log'
    if ($Rest -contains '-f') { Get-Content $log -Tail 200 -Wait } else { Get-Content $log -Tail 200 }
  }
  'update' {
    Assert-GenQRAdmin
    $force = ($Rest -contains '-Force') -or ($Rest -contains '--force')
    & (Join-Path $PSScriptRoot 'update.ps1') -Force:$force
    exit $LASTEXITCODE
  }
  { $_ -in 'reset-password', 'setup-token', 'backup', 'migrate', 'version', 'db-status', 'install-driver' } {
    Invoke-GenQRCli $Command @Rest
    exit $LASTEXITCODE
  }
  { $_ -in 'restore', 'db-switch' } {
    Assert-GenQRAdmin
    Stop-Service $Service
    try {
      Invoke-GenQRCli $Command @Rest
      $code = $LASTEXITCODE
    } finally {
      Start-Service $Service
    }
    if (-not (Wait-GenQRHealthy)) { Write-Warning 'GenQR did not report healthy yet; see: genqrctl logs' }
    exit $code
  }
  { $_ -in 'help', '-h', '--help' } { Show-Usage }
  default { Show-Usage; exit 1 }
}
