param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectId,

  [string]$Region = "asia-northeast1",
  [string]$ServiceName = "legalbridge-admin-ui",
  [string]$ImageName = "legalbridge-admin-ui",
  [string]$RepositoryName = "legalbridge",
  [string]$EnvFile = "cloudrun.admin.env.yaml",
  [string]$SecretFile = "cloudrun.admin.secrets.yaml",
  [int]$MaxInstances = 3,
  [string]$ServiceAccountEmail = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$envFilePath = Join-Path $repoRoot $EnvFile
$secretFilePath = Join-Path $repoRoot $SecretFile
$dockerFilePath = Join-Path $repoRoot "Dockerfile.adminrun"
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
  throw "Dockerfile.adminrun not found: $dockerFilePath"
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

function Should-KeepExistingSecret {
  param(
    [Parameter(Mandatory = $true)]
    [string]$SecretValue
  )

  return $SecretValue -eq "__KEEP_EXISTING_SECRET__"
}

function Build-SecretBindingArg {
  param(
    [Parameter(Mandatory = $true)]
    [hashtable]$Secrets,
    [hashtable]$MountedSecrets = @{}
  )

  $pairs = @()
  foreach ($key in $Secrets.Keys) {
    $pairs += "${key}=${key}:latest"
  }
  foreach ($mountPath in $MountedSecrets.Keys) {
    $pairs += "${mountPath}=$($MountedSecrets[$mountPath]):latest"
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

  $mountedSecrets = [ordered]@{}
  if ($secretValues.Contains("GOOGLE_SERVICE_ACCOUNT_KEY_JSON")) {
    $mountedSecrets["/secrets/gws-service-account.json"] = "GOOGLE_SERVICE_ACCOUNT_KEY_JSON"
    $driveServiceAccountJson = [string]$secretValues["GOOGLE_SERVICE_ACCOUNT_KEY_JSON"]
    $secretValues.Remove("GOOGLE_SERVICE_ACCOUNT_KEY_JSON")
    if (-not (Should-KeepExistingSecret -SecretValue $driveServiceAccountJson)) {
      Ensure-SecretVersion -ProjectId $ProjectId -SecretName "GOOGLE_SERVICE_ACCOUNT_KEY_JSON" -SecretValue $driveServiceAccountJson
    }
  }

  foreach ($secretName in $secretValues.Keys) {
    $secretValue = [string]$secretValues[$secretName]
    if (Should-KeepExistingSecret -SecretValue $secretValue) {
      continue
    }
    Ensure-SecretVersion -ProjectId $ProjectId -SecretName $secretName -SecretValue $secretValue
  }

  $secretBindings = Build-SecretBindingArg -Secrets $secretValues -MountedSecrets $mountedSecrets

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
  if ($mountedSecrets.Count -gt 0) {
    $deployArgs += @("--update-env-vars", "GOOGLE_SERVICE_ACCOUNT_KEY_PATH=/secrets/gws-service-account.json")
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
