Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$appPort = 3100
$adminUrl = "http://localhost:$appPort/admin"
$healthUrl = "http://localhost:$appPort/health"
$dockerDesktop = "C:\Program Files\Docker\Docker\Docker Desktop.exe"
$appStarter = Join-Path $repoRoot "start-local.cmd"

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Start-Process -FilePath "powershell.exe" -Verb RunAs -ArgumentList @(
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    "`"$PSCommandPath`""
  )
  exit 0
}

function Write-Step($message) {
  Write-Host ""
  Write-Host "== $message ==" -ForegroundColor Cyan
}

function Test-PortListening([int]$Port) {
  $listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  return $null -ne $listeners
}

function Test-HttpReady([string]$Url) {
  try {
    $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 5
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
  } catch {
    return $false
  }
}

function Wait-ForCondition {
  param(
    [scriptblock]$Condition,
    [string]$Description,
    [int]$TimeoutSec = 120,
    [int]$IntervalSec = 2
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    if (& $Condition) {
      return $true
    }
    Start-Sleep -Seconds $IntervalSec
  }

  throw "$Description timed out."
}

Push-Location $repoRoot
try {
  Write-Step "Check Docker Desktop"
  $dockerRunning = $false
  try {
    docker version | Out-Null
    $dockerRunning = $true
  } catch {
    $dockerRunning = $false
  }

  if (-not $dockerRunning) {
    if (-not (Test-Path $dockerDesktop)) {
      throw "Docker Desktop not found: $dockerDesktop"
    }
    Start-Process $dockerDesktop
    Wait-ForCondition -Description "Docker Desktop startup" -TimeoutSec 180 -Condition {
      try {
        docker version | Out-Null
        return $true
      } catch {
        return $false
      }
    }
  }

  Write-Step "Start PostgreSQL container"
  docker compose up -d db | Out-Host
  Wait-ForCondition -Description "DB container ready" -TimeoutSec 120 -Condition {
    try {
      $status = docker compose ps
      return $status -match "legalbridge-postgres" -and $status -match "healthy|Up"
    } catch {
      return $false
    }
  }

  Write-Step "Start app"
  if (-not (Test-PortListening -Port $appPort)) {
    if (-not (Test-Path $appStarter)) {
      throw "App starter not found: $appStarter"
    }
    Start-Process -FilePath "cmd.exe" -WorkingDirectory $repoRoot -ArgumentList "/k `"$appStarter`""
  }
  Wait-ForCondition -Description "Web UI ready" -TimeoutSec 120 -Condition { Test-HttpReady -Url $healthUrl }

  Write-Step "Open admin UI"
  Start-Process -FilePath "cmd.exe" -ArgumentList "/c start `"`" `"$adminUrl`""

  Write-Host ""
  Write-Host "Startup complete: $adminUrl" -ForegroundColor Green
} finally {
  Pop-Location
}
