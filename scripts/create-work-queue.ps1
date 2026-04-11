param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectId,

  [string]$Location = "asia-northeast1",
  [string]$QueueName = "legalbridge-work-items",
  [string]$DeadLetterQueueName = "legalbridge-work-items-dlq",
  [int]$MaxAttempts = 5,
  [int]$MinBackoffSeconds = 10,
  [int]$MaxBackoffSeconds = 300,
  [int]$MaxDoublings = 5,
  [int]$MaxRetryDurationSeconds = 3600,
  [double]$MaxDispatchesPerSecond = 5,
  [int]$MaxConcurrentDispatches = 10,
  [switch]$CreateDeadLetterQueue
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not (Get-Command gcloud -ErrorAction SilentlyContinue)) {
  throw "gcloud not found. Install Google Cloud CLI first."
}

function Upsert-Queue {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name
  )

  & gcloud tasks queues describe $Name --location $Location | Out-Null
  if ($LASTEXITCODE -eq 0) {
    & gcloud tasks queues update $Name `
      --location $Location `
      --max-attempts $MaxAttempts `
      --min-backoff "${MinBackoffSeconds}s" `
      --max-backoff "${MaxBackoffSeconds}s" `
      --max-doublings $MaxDoublings `
      --max-retry-duration "${MaxRetryDurationSeconds}s" `
      --max-dispatches-per-second $MaxDispatchesPerSecond `
      --max-concurrent-dispatches $MaxConcurrentDispatches
    if ($LASTEXITCODE -ne 0) { throw "Failed to update queue: $Name" }
    return
  }

  & gcloud tasks queues create $Name `
    --location $Location `
    --max-attempts $MaxAttempts `
    --min-backoff "${MinBackoffSeconds}s" `
    --max-backoff "${MaxBackoffSeconds}s" `
    --max-doublings $MaxDoublings `
    --max-retry-duration "${MaxRetryDurationSeconds}s" `
    --max-dispatches-per-second $MaxDispatchesPerSecond `
    --max-concurrent-dispatches $MaxConcurrentDispatches
  if ($LASTEXITCODE -ne 0) { throw "Failed to create queue: $Name" }
}

& gcloud config set project $ProjectId
if ($LASTEXITCODE -ne 0) { throw "gcloud config set project failed." }

& gcloud services enable cloudtasks.googleapis.com --project $ProjectId
if ($LASTEXITCODE -ne 0) { throw "Failed to enable Cloud Tasks API." }

Upsert-Queue -Name $QueueName

if ($CreateDeadLetterQueue) {
  Upsert-Queue -Name $DeadLetterQueueName
}

Write-Host "Cloud Tasks queue is ready."
Write-Host "  Project:  $ProjectId"
Write-Host "  Location: $Location"
Write-Host "  Queue:    $QueueName"
Write-Host "  Retry:    attempts=$MaxAttempts minBackoff=${MinBackoffSeconds}s maxBackoff=${MaxBackoffSeconds}s maxRetryDuration=${MaxRetryDurationSeconds}s"
Write-Host "  Rate:     maxDispatchesPerSecond=$MaxDispatchesPerSecond maxConcurrentDispatches=$MaxConcurrentDispatches"
if ($CreateDeadLetterQueue) {
  Write-Host "  Dead-letter queue prepared: $DeadLetterQueueName"
} else {
  Write-Host "  Dead-letter queue not created. Use -CreateDeadLetterQueue to provision $DeadLetterQueueName."
}
