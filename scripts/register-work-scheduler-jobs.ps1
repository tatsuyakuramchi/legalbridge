param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectId,

  [Parameter(Mandatory = $true)]
  [string]$WorkServiceUrl,

  [Parameter(Mandatory = $true)]
  [string]$WorkServiceToken,

  [string]$Region = "asia-northeast1",
  [string]$Location = "asia-northeast1",
  [string]$SchedulerJobName = "legalbridge-daily-scheduler",
  [string]$PollerJobName = "legalbridge-backlog-poller",
  [string]$SchedulerCron = "0 9 * * *",
  [string]$PollerCron = "*/10 * * * *",
  [string]$TimeZone = "Asia/Tokyo"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not (Get-Command gcloud -ErrorAction SilentlyContinue)) {
  throw "gcloud not found. Install Google Cloud CLI first."
}

$normalizedWorkServiceUrl = $WorkServiceUrl.TrimEnd("/")
$schedulerUri = "$normalizedWorkServiceUrl/jobs/scheduler"
$pollerUri = "$normalizedWorkServiceUrl/jobs/backlog-poller"
$headers = "Authorization=Bearer $WorkServiceToken"

& gcloud config set project $ProjectId
if ($LASTEXITCODE -ne 0) { throw "gcloud config set project failed." }

& gcloud services enable cloudscheduler.googleapis.com --project $ProjectId
if ($LASTEXITCODE -ne 0) { throw "Failed to enable Cloud Scheduler API." }

function Upsert-HttpSchedulerJob {
  param(
    [Parameter(Mandatory = $true)]
    [string]$JobName,
    [Parameter(Mandatory = $true)]
    [string]$Schedule,
    [Parameter(Mandatory = $true)]
    [string]$Uri
  )

  & gcloud scheduler jobs describe $JobName --location $Location | Out-Null
  if ($LASTEXITCODE -eq 0) {
    & gcloud scheduler jobs update http $JobName `
      --location $Location `
      --schedule $Schedule `
      --time-zone $TimeZone `
      --uri $Uri `
      --http-method POST `
      --headers $headers
    if ($LASTEXITCODE -ne 0) {
      throw "Failed to update scheduler job: $JobName"
    }
    return
  }

  & gcloud scheduler jobs create http $JobName `
    --location $Location `
    --schedule $Schedule `
    --time-zone $TimeZone `
    --uri $Uri `
    --http-method POST `
    --headers $headers
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to create scheduler job: $JobName"
  }
}

Upsert-HttpSchedulerJob -JobName $SchedulerJobName -Schedule $SchedulerCron -Uri $schedulerUri
Upsert-HttpSchedulerJob -JobName $PollerJobName -Schedule $PollerCron -Uri $pollerUri

Write-Host "Scheduler jobs are configured."
Write-Host "  Scheduler: $SchedulerJobName -> $schedulerUri"
Write-Host "  Poller:    $PollerJobName -> $pollerUri"
