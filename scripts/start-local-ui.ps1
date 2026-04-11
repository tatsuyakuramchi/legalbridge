$ErrorActionPreference = "Stop"

Set-Location (Split-Path -Parent $PSScriptRoot)

$env:PORT = "3100"
$env:SKIP_SLACK_STARTUP = "1"

function Wait-ForTcpPort {
  param(
    [string]$HostName,
    [int]$Port,
    [int]$TimeoutSeconds = 60
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $client = $null
    try {
      $client = [System.Net.Sockets.TcpClient]::new()
      $async = $client.BeginConnect($HostName, $Port, $null, $null)
      if ($async.AsyncWaitHandle.WaitOne(1000) -and $client.Connected) {
        $client.EndConnect($async)
        return $true
      }
    } catch {
    } finally {
      if ($client) {
        $client.Dispose()
      }
    }

    Start-Sleep -Seconds 2
  }

  return $false
}

function Invoke-Process {
  param(
    [string]$FilePath,
    [string[]]$ArgumentList
  )

  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $FilePath
  $startInfo.WorkingDirectory = (Get-Location).Path
  $startInfo.UseShellExecute = $false
  $startInfo.RedirectStandardOutput = $false
  $startInfo.RedirectStandardError = $false
  $startInfo.Arguments = ($ArgumentList | ForEach-Object {
    if ($_ -match '[\s"]') {
      '"' + ($_ -replace '"', '\"') + '"'
    } else {
      $_
    }
  }) -join " "

  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  [void]$process.Start()
  $process.WaitForExit()
  return $process.ExitCode
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Write-Host "[ERROR] Docker Desktop (docker command) was not found."
  Write-Host "        Install Docker Desktop and try again."
  exit 1
}

Write-Host "[INFO] Checking Docker database container..."
$dbRunning = $false
if ((Invoke-Process -FilePath "docker" -ArgumentList @("compose", "ps", "db")) -eq 0) {
  $dbRunning = $true
}

if (-not $dbRunning) {
  Write-Host "[INFO] Starting db container..."
  if ((Invoke-Process -FilePath "docker" -ArgumentList @("compose", "up", "-d", "db")) -ne 0) {
    Write-Host "[ERROR] Failed to start the db container."
    Write-Host "        Make sure Docker Desktop is running."
    exit 1
  }
} else {
  Write-Host "[INFO] db container is already running."
}

Write-Host "[INFO] Waiting for PostgreSQL on localhost:5432..."
if (-not (Wait-ForTcpPort -HostName "127.0.0.1" -Port 5432 -TimeoutSeconds 60)) {
  Write-Host "[ERROR] PostgreSQL did not become ready within 60 seconds."
  Write-Host "        Check Docker Desktop and the db container status."
  exit 1
}

& "C:\Program Files\nodejs\npm.cmd" run build
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

& "C:\Program Files\nodejs\npm.cmd" start
exit $LASTEXITCODE
