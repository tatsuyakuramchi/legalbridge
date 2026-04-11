param(
  [Parameter(Mandatory = $true)]
  [string]$RepoRoot,

  [Parameter(Mandatory = $true)]
  [int]$CurrentPid
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$startScript = Join-Path $RepoRoot "start-local.cmd"
if (-not (Test-Path $startScript)) {
  throw "start-local.cmd が見つかりません: $startScript"
}

Start-Sleep -Seconds 2

try {
  $proc = Get-Process -Id $CurrentPid -ErrorAction Stop
  Stop-Process -Id $proc.Id -Force
} catch {
  # 既に停止済みならそのまま続行
}

Start-Sleep -Seconds 2
Start-Process -FilePath "cmd.exe" -WorkingDirectory $RepoRoot -ArgumentList "/k `"$startScript`""
