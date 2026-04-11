param(
  [string]$GatewayEnvFile = "cloudrun.gateway.staging.env.yaml",
  [string]$GatewaySecretFile = "cloudrun.gateway.staging.secrets.yaml",
  [string]$WorkEnvFile = "cloudrun.work.staging.env.yaml",
  [string]$WorkSecretFile = "cloudrun.work.staging.secrets.yaml"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$files = @(
  (Join-Path $repoRoot $GatewayEnvFile),
  (Join-Path $repoRoot $GatewaySecretFile),
  (Join-Path $repoRoot $WorkEnvFile),
  (Join-Path $repoRoot $WorkSecretFile)
)

$placeholderPatterns = @(
  "your-",
  "replace-with",
  "xxxxx",
  "C0000000000",
  "U0000000000",
  "xoxb-staging-xxxxxxxx",
  "staging-signing-secret",
  "staging-backlog-api-key",
  "postgresql://user:password@host:5432/legalbridge_staging",
  "YOUR_STAGING_WORK_SERVICE_TOKEN"
)

$problems = @()

foreach ($file in $files) {
  if (-not (Test-Path $file)) {
    $problems += "Missing file: $file"
    continue
  }

  $lineNo = 0
  foreach ($rawLine in Get-Content -LiteralPath $file -Encoding UTF8) {
    $lineNo += 1
    $line = $rawLine.Trim()
    if (-not $line -or $line.StartsWith("#")) {
      continue
    }

    foreach ($pattern in $placeholderPatterns) {
      if ($line.Contains($pattern)) {
        $problems += "${file}:$lineNo still contains placeholder pattern '$pattern'"
        break
      }
    }
  }
}

if ($problems.Count -gt 0) {
  Write-Host "Staging config validation failed." -ForegroundColor Red
  foreach ($problem in $problems) {
    Write-Host "  $problem"
  }
  exit 1
}

Write-Host "Staging config validation passed."
Write-Host "  Gateway env:    $GatewayEnvFile"
Write-Host "  Gateway secret: $GatewaySecretFile"
Write-Host "  Work env:       $WorkEnvFile"
Write-Host "  Work secret:    $WorkSecretFile"
