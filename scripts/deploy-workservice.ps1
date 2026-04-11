param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectId,

  [string]$Region = "asia-northeast1",
  [string]$ServiceName = "legalbridge-work-service",
  [string]$ImageName = "legalbridge-work-service",
  [string]$RepositoryName = "legalbridge",
  [string]$EnvFile = "cloudrun.work.env.yaml",
  [string]$SecretFile = "cloudrun.work.secrets.yaml",
  [int]$MaxInstances = 3,
  [string]$ServiceAccountEmail = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$envFilePath = Join-Path $repoRoot $EnvFile
$secretFilePath = Join-Path $repoRoot $SecretFile
$dockerFilePath = Join-Path $repoRoot "Dockerfile.workrun"
$dockerBuildPath = Join-Path $repoRoot "Dockerfile"

if (-not (Get-Command gcloud -ErrorAction SilentlyContinue)) {
  throw "gcloud not found. Install Google Cloud CLI first."
}

if (-not (Test-Path $envFilePath)) {
  throw "Env file not found: $envFilePath"
}

if (-not (Test-Path $secretFilePath)) {
  throw "Secret file not found: $secretFilePath"
}

if (-not (Test-Path $dockerFilePath)) {
  throw "Dockerfile.workrun not found: $dockerFilePath"
}

if ($MaxInstances -lt 1) {
  throw "MaxInstances must be 1 or greater."
}

$imageUri = "$Region-docker.pkg.dev/$ProjectId/$RepositoryName/$ImageName"

function Parse-KeyValueYamlFile {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  $result = [ordered]@{}
  foreach ($rawLine in Get-Content -LiteralPath $Path) {
    $line = $rawLine.Trim()
    if (-not $line -or $line.StartsWith("#")) {
      continue
    }

    if ($line -notmatch '^([A-Za-z0-9_]+):\s*(.*)$') {
      throw "Unsupported yaml entry: $rawLine"
    }

    $key = $matches[1]
    $value = $matches[2].Trim()
    if ($value.StartsWith('"') -and $value.EndsWith('"')) {
      $value = $value.Substring(1, $value.Length - 2)
    } elseif ($value.StartsWith("'") -and $value.EndsWith("'")) {
      $value = $value.Substring(1, $value.Length - 2)
    }

    $result[$key] = $value
  }

  return $result
}

function Ensure-SecretVersion {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectId,
    [Parameter(Mandatory = $true)]
    [string]$SecretName,
    [Parameter(Mandatory = $true)]
    [string]$SecretValue
  )

  & gcloud secrets describe $SecretName --project $ProjectId | Out-Null
  if ($LASTEXITCODE -ne 0) {
    & gcloud secrets create $SecretName --replication-policy automatic --project $ProjectId | Out-Null
    if ($LASTEXITCODE -ne 0) {
      throw "Failed to create Secret Manager secret: $SecretName"
    }
  }

  $tempFile = [System.IO.Path]::GetTempFileName()
  try {
    [System.IO.File]::WriteAllText($tempFile, $SecretValue)
    & gcloud secrets versions add $SecretName --data-file $tempFile --project $ProjectId | Out-Null
    if ($LASTEXITCODE -ne 0) {
      throw "Failed to add Secret Manager secret version: $SecretName"
    }
  }
  finally {
    if (Test-Path $tempFile) {
      Remove-Item -LiteralPath $tempFile -Force
    }
  }
}

function Build-SecretBindingArg {
  param(
    [Parameter(Mandatory = $true)]
    [hashtable]$Secrets
  )

  $pairs = @()
  foreach ($key in $Secrets.Keys) {
    $pairs += "${key}=${key}:latest"
  }
  return ($pairs -join ",")
}

Push-Location $repoRoot
try {
  & gcloud config set project $ProjectId
  if ($LASTEXITCODE -ne 0) { throw "gcloud config set project failed." }

  & gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com --project $ProjectId
  if ($LASTEXITCODE -ne 0) { throw "Failed to enable required GCP APIs." }

  $secretValues = Parse-KeyValueYamlFile -Path $secretFilePath
  if ($secretValues.Count -eq 0) {
    throw "Secret file is empty: $secretFilePath"
  }

  foreach ($secretName in $secretValues.Keys) {
    Ensure-SecretVersion -ProjectId $ProjectId -SecretName $secretName -SecretValue ([string]$secretValues[$secretName])
  }

  $secretBindings = Build-SecretBindingArg -Secrets $secretValues

  & gcloud artifacts repositories describe $RepositoryName --location $Region | Out-Null
  if ($LASTEXITCODE -ne 0) {
    & gcloud artifacts repositories create $RepositoryName `
      --repository-format docker `
      --location $Region `
      --description "LegalBridge Cloud Run images"
    if ($LASTEXITCODE -ne 0) { throw "Failed to create Artifact Registry repository." }
  }

  Copy-Item -LiteralPath $dockerFilePath -Destination $dockerBuildPath -Force
  & gcloud builds submit --tag $imageUri .
  if ($LASTEXITCODE -ne 0) { throw "gcloud builds submit failed." }

  $deployArgs = @(
    "run", "deploy", $ServiceName,
    "--image", $imageUri,
    "--platform", "managed",
    "--region", $Region,
    "--allow-unauthenticated",
    "--max-instances", $MaxInstances,
    "--env-vars-file", $envFilePath,
    "--set-secrets", $secretBindings
  )
  if ($ServiceAccountEmail) {
    $deployArgs += @("--service-account", $ServiceAccountEmail)
  }
  & gcloud @deployArgs
  if ($LASTEXITCODE -ne 0) { throw "gcloud run deploy failed." }
}
finally {
  if (Test-Path $dockerBuildPath) {
    Remove-Item -LiteralPath $dockerBuildPath -Force
  }
  Pop-Location
}
