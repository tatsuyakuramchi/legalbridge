param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectId,

  [string]$CommandServiceAccountName = "legalbridge-command-sa",
  [string]$WorkServiceAccountName = "legalbridge-work-sa",
  [string]$SchedulerServiceAccountName = "legalbridge-scheduler-sa"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not (Get-Command gcloud -ErrorAction SilentlyContinue)) {
  throw "gcloud not found. Install Google Cloud CLI first."
}

& gcloud config set project $ProjectId
if ($LASTEXITCODE -ne 0) { throw "gcloud config set project failed." }

& gcloud services enable iam.googleapis.com cloudtasks.googleapis.com secretmanager.googleapis.com run.googleapis.com sqladmin.googleapis.com --project $ProjectId
if ($LASTEXITCODE -ne 0) { throw "Failed to enable required GCP APIs." }

$projectNumber = (& gcloud projects describe $ProjectId --format "value(projectNumber)").Trim()
if (-not $projectNumber) {
  throw "Failed to resolve project number for $ProjectId"
}

function Ensure-ServiceAccount {
  param(
    [Parameter(Mandatory = $true)]
    [string]$AccountName,
    [Parameter(Mandatory = $true)]
    [string]$DisplayName
  )

  $email = "$AccountName@$ProjectId.iam.gserviceaccount.com"
  & gcloud iam service-accounts describe $email --project $ProjectId | Out-Null
  if ($LASTEXITCODE -ne 0) {
    & gcloud iam service-accounts create $AccountName --display-name $DisplayName --project $ProjectId | Out-Null
    if ($LASTEXITCODE -ne 0) {
      throw "Failed to create service account: $email"
    }
  }

  return $email
}

function Ensure-ProjectRole {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Member,
    [Parameter(Mandatory = $true)]
    [string]$Role
  )

  & gcloud projects add-iam-policy-binding $ProjectId `
    --member $Member `
    --role $Role | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to grant $Role to $Member"
  }
}

$commandEmail = Ensure-ServiceAccount -AccountName $CommandServiceAccountName -DisplayName "LegalBridge command-service"
$workEmail = Ensure-ServiceAccount -AccountName $WorkServiceAccountName -DisplayName "LegalBridge work-service"
$schedulerEmail = Ensure-ServiceAccount -AccountName $SchedulerServiceAccountName -DisplayName "LegalBridge scheduler"

Ensure-ProjectRole -Member "serviceAccount:$commandEmail" -Role "roles/secretmanager.secretAccessor"
Ensure-ProjectRole -Member "serviceAccount:$commandEmail" -Role "roles/cloudtasks.enqueuer"

Ensure-ProjectRole -Member "serviceAccount:$workEmail" -Role "roles/secretmanager.secretAccessor"
Ensure-ProjectRole -Member "serviceAccount:$workEmail" -Role "roles/cloudsql.client"

Ensure-ProjectRole -Member "serviceAccount:$schedulerEmail" -Role "roles/secretmanager.secretAccessor"

$cloudTasksServiceAgent = "service-$projectNumber@gcp-sa-cloudtasks.iam.gserviceaccount.com"
Ensure-ProjectRole -Member "serviceAccount:$cloudTasksServiceAgent" -Role "roles/run.invoker"

Write-Host "Service accounts are configured."
Write-Host "  command-service:   $commandEmail"
Write-Host "  work-service:      $workEmail"
Write-Host "  scheduler/helper:  $schedulerEmail"
Write-Host ""
Write-Host "Recommended deploy usage:"
Write-Host "  .\\scripts\\deploy-commandservice.ps1 -ProjectId $ProjectId -ServiceAccountEmail $commandEmail"
Write-Host "  .\\scripts\\deploy-workservice.ps1 -ProjectId $ProjectId -ServiceAccountEmail $workEmail"
