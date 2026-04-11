$ErrorActionPreference = "Stop"

Set-Location (Split-Path -Parent $PSScriptRoot)

$env:PORT = "3100"

function Stop-LocalAppPortOwners {
  param(
    [int[]]$Ports = @(3100, 3101)
  )

  $stopped = @()

  foreach ($port in $Ports) {
    $connections = @(Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue)
    foreach ($connection in $connections) {
      if (-not $connection.OwningProcess) {
        continue
      }

      if ($stopped -contains $connection.OwningProcess) {
        continue
      }

      try {
        $process = Get-Process -Id $connection.OwningProcess -ErrorAction Stop
      } catch {
        continue
      }

      if ($process.ProcessName -ne "node") {
        Write-Host "[WARN] Port $port is used by $($process.ProcessName) (PID $($process.Id)). start-local will not stop it automatically."
        continue
      }

      Write-Host "[INFO] Stopping existing local app on port $port (PID $($process.Id))..."
      Stop-Process -Id $process.Id -Force
      $stopped += $process.Id
    }
  }
}

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

Write-Host "[INFO] Releasing local app ports (3100 / 3101) if needed..."
Stop-LocalAppPortOwners

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

Write-Host "[INFO] Applying Prisma migrations..."
& "C:\Users\tatsuya.kuramochi\Desktop\legalbridge-proto\node_modules\.bin\prisma.cmd" migrate deploy
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

& "C:\Program Files\nodejs\npm.cmd" run build
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

$stdoutLog = Join-Path (Get-Location).Path "tmp\start-local.stdout.log"
$stderrLog = Join-Path (Get-Location).Path "tmp\start-local.stderr.log"

if (-not (Test-Path (Split-Path -Parent $stdoutLog))) {
  New-Item -ItemType Directory -Path (Split-Path -Parent $stdoutLog) | Out-Null
}

Write-Host "[INFO] Starting local app in the background..."
$localApp = Start-Process `
  -FilePath "C:\Program Files\nodejs\node.exe" `
  -ArgumentList "dist/index.js" `
  -WorkingDirectory (Get-Location).Path `
  -RedirectStandardOutput $stdoutLog `
  -RedirectStandardError $stderrLog `
  -PassThru

Start-Sleep -Seconds 4
if ($localApp.HasExited) {
  Write-Host "[ERROR] Local app exited immediately."
  if (Test-Path $stdoutLog) {
    Get-Content $stdoutLog -Tail 50
  }
  if (Test-Path $stderrLog) {
    Get-Content $stderrLog -Tail 50
  }
  exit $localApp.ExitCode
}

Write-Host "[INFO] Local app started in background (PID $($localApp.Id))."
Write-Host "[INFO] Logs:"
Write-Host "       $stdoutLog"
Write-Host "       $stderrLog"
exit 0
