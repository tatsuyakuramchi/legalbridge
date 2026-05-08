param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectId,

  [string]$Region = "asia-northeast1",
  [string]$ServiceName = "legalbridge",
  [string]$ImageName = "legalbridge",
  [string]$RepositoryName = "legalbridge",
  [string]$EnvFile = "cloudrun.gateway.env.yaml",
  [string]$SecretFile = "cloudrun.gateway.secrets.yaml",
  [string]$DockerfilePath = "Dockerfile.adminrun",
  [int]$MaxInstances = 3,
  [string]$ServiceAccountEmail = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptPath = Join-Path $PSScriptRoot "deploy-cloudrun.ps1"
if (-not (Test-Path $scriptPath)) {
  throw "deploy-cloudrun.ps1 not found: $scriptPath"
}

& $scriptPath `
  -ProjectId $ProjectId `
  -Region $Region `
  -ServiceName $ServiceName `
  -ImageName $ImageName `
  -RepositoryName $RepositoryName `
  -EnvFile $EnvFile `
  -SecretFile $SecretFile `
  -DockerfilePath $DockerfilePath `
  -MaxInstances $MaxInstances `
  -ServiceAccountEmail $ServiceAccountEmail

if ($LASTEXITCODE -ne 0) {
  throw "deploy-cloudrun.ps1 failed."
}
