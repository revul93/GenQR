# Shared helpers for update.ps1 and genqrctl.ps1 (Windows). Compatible with Windows PowerShell 5.1.
#
# The GenQR folder is writable only by Administrators and SYSTEM; the service account
# (LocalService) can read it and write only to data, logs, config and drivers. These
# scripts therefore run code that the service account cannot change.

$script:Root = Split-Path -Parent $PSScriptRoot
$script:ServiceName = 'GenQR'

function Get-GenQRRoot { $script:Root }
function Get-GenQRServiceName { $script:ServiceName }

function Write-GenQRInfo([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }

function Test-GenQRAdmin {
  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Assert-GenQRAdmin {
  if (-not (Test-GenQRAdmin)) { throw 'Run this from an elevated PowerShell (Run as administrator).' }
}

function Get-GenQRPort {
  $envFile = Join-Path $script:Root '.env'
  if (Test-Path $envFile) {
    $line = Get-Content $envFile | Where-Object { $_ -match '^PORT=\d+' } | Select-Object -Last 1
    if ($line) { return [int]($line -replace '^PORT=', '') }
  }
  return 3000
}

<#
  Runs a native command, streaming its output to the console (and to $LogFile when given),
  and throws when it fails. Windows PowerShell 5.1 turns stderr lines into errors, so the
  error preference is relaxed while the command runs.
#>
function Invoke-GenQRNative {
  param([Parameter(Mandatory)][scriptblock]$Command, [string]$What = 'Command', [string]$LogFile)
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $Command 2>&1 | ForEach-Object {
      $text = "$_"
      Write-Host $text
      if ($LogFile) { Add-Content -Path $LogFile -Value $text }
    }
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
  }
  if ($code -ne 0) { throw "$What failed (exit code $code)." }
}

# Runs the GenQR command-line tool (server/dist/cli) with the app's environment.
# Its exit code is left in $LASTEXITCODE.
function Invoke-GenQRCli {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
  $env:GENQR_ROOT = $script:Root
  $env:NODE_ENV = 'production'
  Push-Location $script:Root
  try {
    & node (Join-Path $script:Root 'server\dist\cli\index.js') @Arguments
  } finally {
    Pop-Location
  }
}

function Get-GenQRHealth {
  try {
    return Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/api/health" -f (Get-GenQRPort)) -TimeoutSec 3
  } catch {
    return $null
  }
}

# Waits until /api/health answers (optionally on a given commit). Returns $true/$false.
function Wait-GenQRHealthy {
  param([string]$Commit, [int]$TimeoutSeconds = 120)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $health = Get-GenQRHealth
    if ($health -and (-not $Commit -or $health.commit -eq $Commit)) { return $true }
    Start-Sleep -Seconds 2
  }
  return $false
}

Export-ModuleMember -Function *-GenQR*
