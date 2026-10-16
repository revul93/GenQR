<#
.SYNOPSIS
  GenQR installer for Windows (Windows Server 2019+ / Windows 10+), Windows PowerShell 5.1 or later.

.DESCRIPTION
  From an elevated PowerShell:

    irm https://raw.githubusercontent.com/revul93/GenQR/main/scripts/install.ps1 | iex

  Optional settings (set before running, e.g. $env:GENQR_PORT = '8080'):
    GENQR_REPO     git URL to clone            (default: https://github.com/revul93/GenQR.git)
    GENQR_BRANCH   branch to track             (default: main)
    GENQR_DIR      install directory           (default: C:\GenQR)
    GENQR_PORT     HTTP port of the app        (default: 3000)
    GENQR_HOST     address the app listens on  (default: 0.0.0.0; use 127.0.0.1 behind IIS)

  What it sets up:
    - Node.js 22 LTS, Git and NSSM (via winget) when missing
    - The code in GENQR_DIR, writable only by Administrators and SYSTEM
    - A "GenQR" Windows service (NSSM) running as NT AUTHORITY\LocalService, which can read
      the code and write only to data, logs, config and drivers
    - A "GenQR Update Watcher" scheduled task (SYSTEM) for the "Update now" button
    - genqrctl on the machine PATH, and an inbound firewall rule for the port

  Running it again on an installed server refreshes the service and task settings and
  then updates GenQR.
#>

$ErrorActionPreference = 'Stop'

function Get-Setting([string]$Name, [string]$Default) {
  $value = [Environment]::GetEnvironmentVariable($Name)
  if ($value) { return $value } else { return $Default }
}

$Repo = Get-Setting 'GENQR_REPO' 'https://github.com/revul93/GenQR.git'
$Branch = Get-Setting 'GENQR_BRANCH' 'main'
$Dir = Get-Setting 'GENQR_DIR' 'C:\GenQR'
$Port = Get-Setting 'GENQR_PORT' '3000'
$ListenHost = Get-Setting 'GENQR_HOST' '0.0.0.0'
$Service = 'GenQR'
$TaskName = 'GenQR Update Watcher'
$NodeMajor = 22

function Info([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this from an elevated PowerShell (Run as administrator).'
}

function Update-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

function Invoke-Native([scriptblock]$Command, [string]$What) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $Command 2>&1 | ForEach-Object { Write-Host "$_" }; $code = $LASTEXITCODE } finally { $ErrorActionPreference = $previous }
  if ($code -ne 0) { throw "$What failed (exit code $code)." }
}

function Install-Package([string]$Id, [string]$Name, [switch]$Machine) {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw "$Name is missing and winget is not available. Install $Name manually, then run this installer again."
  }
  Info "Installing $Name (winget $Id)"
  $scope = @(); if ($Machine) { $scope = @('--scope', 'machine') }
  Invoke-Native { winget install --id $Id -e --silent --accept-package-agreements --accept-source-agreements @scope } "Installing $Name"
  Update-Path
}

# --- Prerequisites ---------------------------------------------------------------------
Update-Path
$nodeVersion = 0
# Parsed in PowerShell: Windows PowerShell 5.1 strips the inner quotes of JavaScript passed to `node -e/-p`.
if (Get-Command node -ErrorAction SilentlyContinue) { $nodeVersion = [int](((& node -v) | Out-String).Trim().TrimStart('v').Split('.')[0]) }
if ($nodeVersion -lt $NodeMajor) { Install-Package 'OpenJS.NodeJS.LTS' 'Node.js LTS' -Machine }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Install-Package 'Git.Git' 'Git' -Machine }
if (-not (Get-Command nssm -ErrorAction SilentlyContinue) -and -not (Test-Path (Join-Path $Dir 'bin\nssm.exe'))) { Install-Package 'NSSM.NSSM' 'NSSM' }
$node = (Get-Command node).Source
Info "Using Node.js $(& node -v)"

# git refuses repositories owned by another account unless listed as safe; the service
# (LocalService) and the update task (SYSTEM) both read this one.
$safeDir = $Dir -replace '\\', '/'
$safe = @(& git config --system --get-all safe.directory 2>$null)
if ($safe -notcontains $safeDir) { & git config --system --add safe.directory $safeDir }

# --- Permissions ---------------------------------------------------------------------------
# Administrators/SYSTEM: full control. LocalService: read the code; modify only data, logs,
# config, drivers. Backups: Administrators/SYSTEM only. Well-known SIDs avoid localisation issues.
function Set-GenQRPermissions {
  $admins = '*S-1-5-32-544'; $system = '*S-1-5-18'; $svc = '*S-1-5-19'
  Invoke-Native { icacls $Dir /inheritance:r /grant:r "${admins}:(OI)(CI)F" "${system}:(OI)(CI)F" "${svc}:(OI)(CI)RX" /Q } 'Setting folder permissions'
  foreach ($d in 'data', 'logs', 'config', 'drivers') {
    $path = Join-Path $Dir $d
    New-Item -ItemType Directory -Force -Path $path | Out-Null
    Invoke-Native { icacls $path /grant "${svc}:(OI)(CI)M" /Q } "Setting permissions on $d"
  }
  $backups = Join-Path $Dir 'backups'
  New-Item -ItemType Directory -Force -Path $backups | Out-Null
  Invoke-Native { icacls $backups /inheritance:r /grant:r "${admins}:(OI)(CI)F" "${system}:(OI)(CI)F" /Q } 'Setting permissions on backups'
  $envFile = Join-Path $Dir '.env'
  if (Test-Path $envFile) { Invoke-Native { icacls $envFile /inheritance:r /grant:r "${admins}:F" "${system}:F" "${svc}:R" /Q } 'Setting permissions on .env' }
}

# --- Service, update task, genqrctl --------------------------------------------------------
function Install-GenQRService {
  $binDir = Join-Path $Dir 'bin'
  New-Item -ItemType Directory -Force -Path $binDir | Out-Null
  $nssm = Join-Path $binDir 'nssm.exe'
  if (-not (Test-Path $nssm)) { Copy-Item (Get-Command nssm).Source $nssm }

  if (-not (Get-Service $Service -ErrorAction SilentlyContinue)) {
    Invoke-Native { & $nssm install $Service $node (Join-Path $Dir 'server\dist\index.js') } 'Creating the service'
  }
  $settings = @(
    @('Application', $node),
    @('AppParameters', (Join-Path $Dir 'server\dist\index.js')),
    @('AppDirectory', $Dir),
    @('DisplayName', 'GenQR'),
    @('Description', 'GenQR - QR code generator and short-link service'),
    @('Start', 'SERVICE_AUTO_START'),
    @('AppStdout', (Join-Path $Dir 'logs\service.log')),
    @('AppStderr', (Join-Path $Dir 'logs\service.log')),
    # Rotate the log when the service starts. Online (live) rotation is off: with it on, NSSM
    # hung in "Stop pending" after GenQR had already exited.
    @('AppRotateFiles', '1'),
    @('AppRotateOnline', '0'),
    @('AppRotateBytes', '10485760'),
    # GenQR shuts down on Ctrl+C (closes connections and the database); give it time, then
    # fall back to stronger stop methods.
    @('AppStopMethodConsole', '15000'),
    @('AppStopMethodWindow', '3000'),
    @('AppStopMethodThreads', '3000'),
    # Restart on any exit: the app exits on purpose to restart itself (e.g. after a database switch).
    @('AppExit', 'Default', 'Restart'),
    @('AppRestartDelay', '3000')
  )
  foreach ($s in $settings) { Invoke-Native { & $nssm set $Service @s } "Configuring the service ($($s[0]))" }
  # Run as LocalService. Set through the service API: Windows PowerShell 5.1 drops the empty
  # password argument NSSM would need.
  $result = Get-CimInstance Win32_Service -Filter "Name='$Service'" | Invoke-CimMethod -MethodName Change -Arguments @{ StartName = 'NT AUTHORITY\LocalService'; StartPassword = '' }
  if ($result.ReturnValue -ne 0) { throw "Could not set the service account (Win32_Service.Change returned $($result.ReturnValue))." }
  Invoke-Native { & $nssm set $Service AppEnvironmentExtra 'NODE_ENV=production' "GENQR_ROOT=$Dir" 'GENQR_SUPERVISED=1' "NPM_CONFIG_CACHE=$(Join-Path $Dir 'data\npm-cache')" } 'Configuring the service environment'

  # The "Update now" button drops data\update.request; this task (SYSTEM) checks every minute.
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -File "{0}" -FromUi' -f (Join-Path $Dir 'scripts\update.ps1'))
  $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 1)
  $taskPrincipal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $taskSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -StartWhenAvailable
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $taskPrincipal -Settings $taskSettings -Force | Out-Null

  # genqrctl on the machine PATH.
  Set-Content -Path (Join-Path $binDir 'genqrctl.cmd') -Encoding ASCII -Value '@powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\scripts\genqrctl.ps1" %*'
  $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  if (($machinePath -split ';') -notcontains $binDir) { [Environment]::SetEnvironmentVariable('Path', "$machinePath;$binDir", 'Machine') }
  Update-Path

  if ($ListenHost -ne '127.0.0.1' -and -not (Get-NetFirewallRule -DisplayName 'GenQR' -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName 'GenQR' -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow | Out-Null
  }
}

function Wait-Healthy {
  for ($i = 0; $i -lt 60; $i++) {
    try { Invoke-RestMethod "http://127.0.0.1:$Port/api/health" -TimeoutSec 3 | Out-Null; return $true } catch { Start-Sleep -Seconds 2 }
  }
  return $false
}

# --- Existing installation -------------------------------------------------------------------
# A folder with .git but no build or .env is an earlier attempt that stopped part-way: resume it below.
$installed = (Test-Path (Join-Path $Dir '.git')) -and (Test-Path (Join-Path $Dir 'server\dist\index.js')) -and (Test-Path (Join-Path $Dir '.env'))
if ($installed) {
  Info "GenQR is already installed in $Dir - refreshing the service and update task"
  Invoke-Native { git -C $Dir fetch --quiet origin $Branch } 'Fetching updates'
  Invoke-Native { git -C $Dir merge --quiet --ff-only "origin/$Branch" } 'Applying updates (local changes in the GenQR folder prevent this; inspect with git status)'
  Set-GenQRPermissions
  Install-GenQRService
  Info 'Updating GenQR'
  & (Join-Path $Dir 'scripts\update.ps1') -Force
  # return, not exit: under `irm | iex` exit would close the administrator's PowerShell window.
  return
}

# --- Fresh installation ------------------------------------------------------------------------
if (Test-Path (Join-Path $Dir '.git')) {
  Info "Resuming an unfinished installation in $Dir"
  Invoke-Native { git -C $Dir fetch --quiet origin $Branch } 'Fetching the code'
  Invoke-Native { git -C $Dir merge --quiet --ff-only "origin/$Branch" } 'Updating the code (local changes in the GenQR folder prevent this; inspect with git status)'
} else {
  if ((Test-Path $Dir) -and (Get-ChildItem $Dir -Force | Select-Object -First 1)) { throw "$Dir exists and is not empty. Remove it or set GENQR_DIR." }
  Info "Cloning $Repo ($Branch) into $Dir"
  Invoke-Native { git clone --quiet --branch $Branch $Repo $Dir } 'Cloning the repository'
}

Info 'Installing dependencies and building (this can take a few minutes)'
Push-Location $Dir
try {
  # npm.cmd, not npm: PowerShell would pick npm.ps1, which a restrictive execution policy blocks.
  Invoke-Native { npm.cmd ci --include=dev --no-audit --no-fund --loglevel=error } 'npm ci'
  Invoke-Native { npm.cmd run build --silent } 'Building'

  Info 'Writing configuration'
  if (-not (Test-Path '.env')) {
    $bytes = New-Object byte[] 32
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $key = [Convert]::ToBase64String($bytes)
    (Get-Content '.env.example') -replace '^PORT=.*', "PORT=$Port" -replace '^HOST=.*', "HOST=$ListenHost" -replace '^ENCRYPTION_KEY=.*', "ENCRYPTION_KEY=$key" |
      Set-Content -Path '.env' -Encoding ASCII
  }
  if (-not (Test-Path 'config\database.json')) { Copy-Item 'config\database.example.json' 'config\database.json' }
  Set-GenQRPermissions

  Info 'Creating the database'
  $env:GENQR_ROOT = $Dir
  Invoke-Native { node server\dist\cli\index.js migrate } 'Creating the database'
} finally {
  Pop-Location
}

Info 'Installing the Windows service, update task and genqrctl'
Install-GenQRService
Start-Service $Service
Info 'Waiting for GenQR to start'
if (-not (Wait-Healthy)) { throw "GenQR did not start. See $Dir\logs\service.log" }

$token = ((& node (Join-Path $Dir 'server\dist\cli\index.js') setup-token 2>$null) | Out-String).Trim()
$ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.PrefixOrigin -ne 'WellKnown' } | Select-Object -First 1).IPAddress

Write-Host ''
Write-Host '  GenQR is installed and running.' -ForegroundColor Green
Write-Host ''
Write-Host "  Open:         http://${ip}:$Port/"
Write-Host "  Setup token:  $token"
Write-Host ''
Write-Host '  Next steps:'
Write-Host '    - Put IIS (URL Rewrite + ARR) or another reverse proxy with HTTPS in front of it,'
Write-Host "      then set HOST=127.0.0.1 in $Dir\.env and run: genqrctl restart"
Write-Host '    - Complete the setup wizard in the browser using the token above.'
Write-Host ''
Write-Host '  Manage it with (new prompt): genqrctl status | start | stop | restart | logs | update | reset-password <user>'
Write-Host ''
