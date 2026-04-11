param(
  [string]$InputDir = "C:\Users\tatsuya.kuramochi\Desktop\legalbridge-proto\tmp\dryrun-planning",
  [string]$ManifestPath = ""
)

$pythonCandidates = @(
  $env:PYTHON_WEASYPRINT_PATH,
  (Join-Path $env:LOCALAPPDATA "Programs\Python\Python312\python.exe"),
  "python"
) | Where-Object { $_ -and $_.Trim() -ne "" }

$pythonExe = $null
foreach ($candidate in $pythonCandidates) {
  try {
    & $candidate --version *> $null
    $pythonExe = $candidate
    break
  } catch {
    continue
  }
}

if (-not $pythonExe) {
  throw "Python executable for WeasyPrint was not found."
}

if (-not (Test-Path -LiteralPath $InputDir)) {
  throw "Input directory was not found: $InputDir"
}

if (-not $ManifestPath) {
  $latestManifest = Get-ChildItem -LiteralPath $InputDir -Filter *_manifest.json |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if ($latestManifest) {
    $ManifestPath = $latestManifest.FullName
  }
}

$htmlFiles = @()
if ($ManifestPath) {
  if (-not (Test-Path -LiteralPath $ManifestPath)) {
    throw "Manifest file was not found: $ManifestPath"
  }

  $manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
  if ($manifest.renderedDocs) {
    foreach ($doc in $manifest.renderedDocs) {
      if ($doc.htmlPath -and (Test-Path -LiteralPath $doc.htmlPath)) {
        $htmlFiles += Get-Item -LiteralPath $doc.htmlPath
      }
    }
  }
} else {
  $htmlFiles = Get-ChildItem -LiteralPath $InputDir -Filter *.html | Sort-Object Name
}

if ($htmlFiles.Count -eq 0) {
  throw "No HTML files were found for conversion."
}

$results = @()
foreach ($file in $htmlFiles) {
  $pdfPath = [System.IO.Path]::ChangeExtension($file.FullName, ".pdf")
  try {
    & $pythonExe -m weasyprint $file.FullName $pdfPath
    $results += [PSCustomObject]@{
      html = $file.FullName
      pdf  = $pdfPath
      ok   = $true
    }
    Write-Host "[OK] $($file.Name) -> $([System.IO.Path]::GetFileName($pdfPath))"
  } catch {
    $results += [PSCustomObject]@{
      html = $file.FullName
      pdf  = $pdfPath
      ok   = $false
      error = $_.Exception.Message
    }
    Write-Warning "[FAIL] $($file.Name): $($_.Exception.Message)"
  }
}

$manifestDir = if ($ManifestPath) { Split-Path -Parent $ManifestPath } else { $InputDir }
$manifestBase = if ($ManifestPath) { [System.IO.Path]::GetFileNameWithoutExtension($ManifestPath) + "_pdf-manifest.json" } else { "pdf-manifest.json" }
$manifestPath = Join-Path $manifestDir $manifestBase
$results | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
Write-Host "manifest: $manifestPath"
