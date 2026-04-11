param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectId,

  [string]$Region = "asia-northeast1",
  [string]$Location = "asia-northeast1",
  [string]$CommandServiceName = "legalbridge-command-service-staging",
  [string]$WorkServiceName = "legalbridge-work-service-staging",
  [string]$QueueName = "legalbridge-work-items-staging",
  [string]$CommandServiceAccountEmail = "",
  [string]$WorkServiceAccountEmail = "",
  [string]$GatewayEnvFile = "cloudrun.gateway.staging.env.yaml",
  [string]$GatewaySecretFile = "cloudrun.gateway.staging.secrets.yaml",
  [string]$WorkEnvFile = "cloudrun.work.staging.env.yaml",
  [string]$WorkSecretFile = "cloudrun.work.staging.secrets.yaml",
  [string]$WorkServiceUrl = "",
  [string]$WorkServiceToken = "",
  [switch]$SkipIam,
  [switch]$SkipQueue,
  [switch]$SkipScheduler
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptsDir = $PSScriptRoot

Invoke-Step -Label "Validate staging config" -Action {
  & (Join-Path $scriptsDir "validate-staging-config.ps1") `
    -GatewayEnvFile $GatewayEnvFile `
    -GatewaySecretFile $GatewaySecretFile `
    -WorkEnvFile $WorkEnvFile `
    -WorkSecretFile $WorkSecretFile
  if ($LASTEXITCODE -ne 0) {
    throw "Staging config validation failed."
  }
}

function Invoke-Step {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Label,
    [Parameter(Mandatory = $true)]
    [scriptblock]$Action
  )

  Write-Host ""
  Write-Host "== $Label =="
  & $Action
}

if (-not $SkipIam) {
  Invoke-Step -Label "IAM setup" -Action {
    & (Join-Path $scriptsDir "setup-gcp-service-accounts.ps1") `
      -ProjectId $ProjectId
    if ($LASTEXITCODE -ne 0) {
      throw "IAM setup failed."
    }
  }
}

if (-not $SkipQueue) {
  Invoke-Step -Label "Cloud Tasks queue" -Action {
    & (Join-Path $scriptsDir "create-work-queue.ps1") `
      -ProjectId $ProjectId `
      -Location $Location `
      -QueueName $QueueName
    if ($LASTEXITCODE -ne 0) {
      throw "Queue setup failed."
    }
  }
}

Invoke-Step -Label "Deploy work-service" -Action {
  $args = @(
    "-ProjectId", $ProjectId,
    "-Region", $Region,
    "-ServiceName", $WorkServiceName,
    "-ImageName", $WorkServiceName,
    "-EnvFile", $WorkEnvFile,
    "-SecretFile", $WorkSecretFile
  )
  if ($WorkServiceAccountEmail) {
    $args += @("-ServiceAccountEmail", $WorkServiceAccountEmail)
  }

  & (Join-Path $scriptsDir "deploy-workservice.ps1") @args
  if ($LASTEXITCODE -ne 0) {
    throw "work-service deploy failed."
  }
}

Invoke-Step -Label "Deploy command-service" -Action {
  $args = @(
    "-ProjectId", $ProjectId,
    "-Region", $Region,
    "-ServiceName", $CommandServiceName,
    "-ImageName", $CommandServiceName,
    "-EnvFile", $GatewayEnvFile,
    "-SecretFile", $GatewaySecretFile
  )
  if ($CommandServiceAccountEmail) {
    $args += @("-ServiceAccountEmail", $CommandServiceAccountEmail)
  }

  & (Join-Path $scriptsDir "deploy-commandservice.ps1") @args
  if ($LASTEXITCODE -ne 0) {
    throw "command-service deploy failed."
  }
}

if (-not $SkipScheduler) {
  if (-not $WorkServiceUrl) {
    throw "WorkServiceUrl is required unless -SkipScheduler is set."
  }
  if (-not $WorkServiceToken) {
    throw "WorkServiceToken is required unless -SkipScheduler is set."
  }

  Invoke-Step -Label "Register Cloud Scheduler jobs" -Action {
    & (Join-Path $scriptsDir "register-work-scheduler-jobs.ps1") `
      -ProjectId $ProjectId `
      -Region $Region `
      -Location $Location `
      -WorkServiceUrl $WorkServiceUrl `
      -WorkServiceToken $WorkServiceToken `
      -SchedulerJobName "legalbridge-daily-scheduler-staging" `
      -PollerJobName "legalbridge-backlog-poller-staging"
    if ($LASTEXITCODE -ne 0) {
      throw "Scheduler setup failed."
    }
  }
}

Write-Host ""
Write-Host "Staging bootstrap finished."
Write-Host "  Project:          $ProjectId"
Write-Host "  Command service:  $CommandServiceName"
Write-Host "  Work service:     $WorkServiceName"
Write-Host "  Queue:            $QueueName"
