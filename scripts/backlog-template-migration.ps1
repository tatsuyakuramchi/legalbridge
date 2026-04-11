param(
  [ValidateSet("backup", "plan", "apply-issue-types", "apply-delete-fields", "apply-add-fields", "apply-patch-fields")]
  [string]$Mode = "plan",
  [string]$OutputDir = "C:\Users\tatsuya.kuramochi\Desktop\legalbridge-proto\tmp\backlog-migration"
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $repoRoot ".env"

if (Test-Path -LiteralPath $envFile) {
  Get-Content -Path $envFile | ForEach-Object {
    if ($_ -match '^\s*#') { return }
    if ($_ -match '^\s*$') { return }
    if ($_ -match '^\s*([^=]+)=(.*)$') {
      $name = $matches[1].Trim()
      $value = $matches[2].Trim()
      if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
        $value = $value.Substring(1, $value.Length - 2)
      }
      if (-not [string]::IsNullOrWhiteSpace($name) -and -not (Test-Path "Env:$name")) {
        Set-Item -Path "Env:$name" -Value $value
      }
    }
  }
}

if (-not $env:BACKLOG_SPACE) { throw "BACKLOG_SPACE が未設定です。" }
if (-not $env:BACKLOG_API_KEY) { throw "BACKLOG_API_KEY が未設定です。" }
if (-not $env:BACKLOG_PROJECT_KEY) { throw "BACKLOG_PROJECT_KEY が未設定です。" }

$baseUrl = "https://$($env:BACKLOG_SPACE).backlog.com/api/v2"
$projectKey = $env:BACKLOG_PROJECT_KEY

function Invoke-BacklogApi {
  param(
    [ValidateSet("GET", "POST", "PATCH", "DELETE")]
    [string]$Method,
    [string]$Path,
    [hashtable]$Query = @{},
    [hashtable]$Form = @{}
  )

  $queryWithKey = @{}
  foreach ($pair in $Query.GetEnumerator()) {
    $queryWithKey[$pair.Key] = $pair.Value
  }
  $queryWithKey["apiKey"] = $env:BACKLOG_API_KEY

  $uriBuilder = [System.UriBuilder]::new("$baseUrl$Path")
  $encodedPairs = New-Object System.Collections.Generic.List[string]
  foreach ($pair in $queryWithKey.GetEnumerator()) {
    if ($pair.Value -is [System.Collections.IEnumerable] -and -not ($pair.Value -is [string])) {
      foreach ($item in $pair.Value) {
        $encodedPairs.Add(([uri]::EscapeDataString([string]$pair.Key) + "=" + [uri]::EscapeDataString([string]$item)))
      }
    } else {
      $encodedPairs.Add(([uri]::EscapeDataString([string]$pair.Key) + "=" + [uri]::EscapeDataString([string]$pair.Value)))
    }
  }
  $uriBuilder.Query = ($encodedPairs -join "&")
  $uri = $uriBuilder.Uri.AbsoluteUri

  if ($Method -eq "GET" -or $Method -eq "DELETE") {
    return Invoke-RestMethod -Method $Method -Uri $uri
  }

  $bodyPairs = New-Object System.Collections.Generic.List[string]
  foreach ($pair in $Form.GetEnumerator()) {
    if ($pair.Value -is [System.Collections.IEnumerable] -and -not ($pair.Value -is [string])) {
      foreach ($item in $pair.Value) {
        $bodyPairs.Add(([uri]::EscapeDataString([string]$pair.Key) + "=" + [uri]::EscapeDataString([string]$item)))
      }
    } else {
      $bodyPairs.Add(([uri]::EscapeDataString([string]$pair.Key) + "=" + [uri]::EscapeDataString([string]$pair.Value)))
    }
  }
  $body = $bodyPairs -join "&"
  return Invoke-RestMethod -Method $Method -Uri $uri -ContentType "application/x-www-form-urlencoded" -Body $body
}

function Get-IssueTypes {
  Invoke-BacklogApi -Method GET -Path "/projects/$projectKey/issueTypes"
}

function Get-CustomFields {
  Invoke-BacklogApi -Method GET -Path "/projects/$projectKey/customFields"
}

function Resolve-IssueTypeIds {
  param([string[]]$Names)
  $issueTypes = Get-IssueTypes
  $ids = @()
  foreach ($name in $Names) {
    $matched = $issueTypes | Where-Object { $_.name -eq $name } | Select-Object -First 1
    if (-not $matched) {
      throw "課題タイプが見つかりません: $name"
    }
    $ids += [string]$matched.id
  }
  return $ids
}

$issueTypesToAdd = @(
  @{ name = "個別利用許諾条件"; color = "#934981"; templateSummary = ""; templateDescription = "" },
  @{ name = "製造案件"; color = "#666665"; templateSummary = ""; templateDescription = "" }
)

$obsoleteCustomFieldNames = @(
  "special_terms",
  "approval_comments",
  "approval_date",
  "approver_department",
  "approver_name",
  "business_description",
  "delivery_type",
  "delivery_url",
  "milestone_name",
  "partial_number",
  "person_department",
  "person_name",
  "project_name",
  "reviewer_department",
  "reviewer_name",
  "is_final_delivery",
  "amountchangereason",
  "completiondate",
  "hasamountchange",
  "hasrevision",
  "iscompleted",
  "name",
  "newamount",
  "no",
  "notes",
  "originalamount",
  "revisiondetail",
  "spec",
  "thistimequantity",
  "totalquantity",
  "unitprice",
  "issue_date",
  "date",
  "detail",
  "qty",
  "rate",
  "baseamount",
  "calculation",
  "deduction",
  "deduction_note",
  "minimum_guarantee",
  "payment_date",
  "payment_due_date",
  "period",
  "period_text",
  "revshare_basis",
  "revshare_note",
  "special_note",
  "unit_price"
)

$customFieldsToAdd = @(
  @{ typeId = 1; name = "counterparty"; description = "相手方"; required = "false"; issueTypes = @("業務委託基本契約", "ライセンス契約", "NDA", "個別利用許諾条件", "売買契約（当社買手）", "売買契約（当社売手・標準）", "売買契約（当社売手・保証金掛け売り）", "発注書", "企画発注書") },
  @{ typeId = 1; name = "contract_no"; description = "契約書番号"; required = "false"; issueTypes = @("業務委託基本契約", "ライセンス契約", "NDA", "個別利用許諾条件", "売買契約（当社買手）", "売買契約（当社売手・標準）", "売買契約（当社売手・保証金掛け売り）", "発注書", "企画発注書") },
  @{ typeId = 1; name = "counterparty_address"; description = "相手方住所"; required = "false"; issueTypes = @("業務委託基本契約", "ライセンス契約", "NDA", "個別利用許諾条件", "売買契約（当社買手）", "売買契約（当社売手・標準）", "売買契約（当社売手・保証金掛け売り）", "発注書", "企画発注書") },
  @{ typeId = 1; name = "counterparty_rep"; description = "相手方代表者"; required = "false"; issueTypes = @("業務委託基本契約", "ライセンス契約", "NDA", "個別利用許諾条件", "売買契約（当社買手）", "売買契約（当社売手・標準）", "売買契約（当社売手・保証金掛け売り）", "発注書", "企画発注書") },
  @{ typeId = 2; name = "special_notes"; description = "特約・特記事項"; required = "false"; issueTypes = @("業務委託基本契約", "ライセンス契約", "NDA", "個別利用許諾条件", "売買契約（当社買手）", "売買契約（当社売手・標準）", "売買契約（当社売手・保証金掛け売り）", "発注書", "企画発注書") },
  @{ typeId = 4; name = "deadline"; description = "希望完了日"; required = "false"; issueTypes = @("業務委託基本契約", "ライセンス契約", "NDA", "個別利用許諾条件", "売買契約（当社買手）", "売買契約（当社売手・標準）", "売買契約（当社売手・保証金掛け売り）", "発注書", "企画発注書") },
  @{ typeId = 1; name = "contract_type"; description = "文書種別"; required = "false"; issueTypes = @("業務委託基本契約", "ライセンス契約", "NDA", "個別利用許諾条件", "売買契約（当社買手）", "売買契約（当社売手・標準）", "売買契約（当社売手・保証金掛け売り）", "発注書", "企画発注書", "納品リクエスト", "製造案件") },

  @{ typeId = 1; name = "license_type_name"; description = "ライセンス種別名"; required = "false"; issueTypes = @("個別利用許諾条件") },
  @{ typeId = 4; name = "license_start"; description = "許諾開始日"; required = "false"; issueTypes = @("個別利用許諾条件") },
  @{ typeId = 1; name = "territory"; description = "許諾地域・言語"; required = "false"; issueTypes = @("個別利用許諾条件") },
  @{ typeId = 1; name = "calc_type_label"; description = "計算方式表示"; required = "false"; issueTypes = @("個別利用許諾条件") },
  @{ typeId = 1; name = "royalty_rate_label"; description = "料率表示"; required = "false"; issueTypes = @("個別利用許諾条件") },
  @{ typeId = 2; name = "payment_terms_text"; description = "支払条件表示"; required = "false"; issueTypes = @("個別利用許諾条件") },
  @{ typeId = 1; name = "mg_ag_text"; description = "MG/AG表示"; required = "false"; issueTypes = @("個別利用許諾条件") },
  @{ typeId = 1; name = "material_code"; description = "素材番号"; required = "false"; issueTypes = @("個別利用許諾条件") },
  @{ typeId = 1; name = "material_name"; description = "素材名"; required = "false"; issueTypes = @("個別利用許諾条件") },
  @{ typeId = 1; name = "material_rights_holder"; description = "素材権利者"; required = "false"; issueTypes = @("個別利用許諾条件") },
  @{ typeId = 1; name = "supervisor"; description = "監修者"; required = "false"; issueTypes = @("個別利用許諾条件") },

  @{ typeId = 1; name = "condition1_region_language_label"; description = "金銭条件1 地域・言語"; required = "false"; issueTypes = @("個別利用許諾条件") },
  @{ typeId = 1; name = "condition1_calc_method"; description = "金銭条件1 計算方式"; required = "false"; issueTypes = @("個別利用許諾条件") },
  @{ typeId = 2; name = "condition1_formula"; description = "金銭条件1 計算式"; required = "false"; issueTypes = @("個別利用許諾条件") },
  @{ typeId = 1; name = "condition1_base_price_label"; description = "金銭条件1 基準価格ラベル"; required = "false"; issueTypes = @("個別利用許諾条件") },
  @{ typeId = 1; name = "condition1_rate"; description = "金銭条件1 料率"; required = "false"; issueTypes = @("個別利用許諾条件") },
  @{ typeId = 2; name = "condition1_payment_terms"; description = "金銭条件1 支払条件"; required = "false"; issueTypes = @("個別利用許諾条件") },
  @{ typeId = 1; name = "condition1_mg_ag"; description = "金銭条件1 MG/AG"; required = "false"; issueTypes = @("個別利用許諾条件") },
  @{ typeId = 2; name = "condition1_note"; description = "金銭条件1 補足"; required = "false"; issueTypes = @("個別利用許諾条件") },

  @{ typeId = 1; name = "condition2_heading"; description = "金銭条件2 見出し"; required = "false"; issueTypes = @("個別利用許諾条件") },
  @{ typeId = 1; name = "condition2_region"; description = "金銭条件2 地域"; required = "false"; issueTypes = @("個別利用許諾条件") },
  @{ typeId = 1; name = "condition2_language"; description = "金銭条件2 言語"; required = "false"; issueTypes = @("個別利用許諾条件") },
  @{ typeId = 1; name = "condition2_calc_method"; description = "金銭条件2 計算方式"; required = "false"; issueTypes = @("個別利用許諾条件") },
  @{ typeId = 2; name = "condition2_summary"; description = "金銭条件2 概要"; required = "false"; issueTypes = @("個別利用許諾条件") },
  @{ typeId = 2; name = "condition2_formula"; description = "金銭条件2 計算式"; required = "false"; issueTypes = @("個別利用許諾条件") },
  @{ typeId = 1; name = "condition2_share_rate"; description = "金銭条件2 分配率"; required = "false"; issueTypes = @("個別利用許諾条件") },
  @{ typeId = 2; name = "condition2_payment_terms"; description = "金銭条件2 支払条件"; required = "false"; issueTypes = @("個別利用許諾条件") },
  @{ typeId = 1; name = "condition2_mg_ag"; description = "金銭条件2 MG/AG"; required = "false"; issueTypes = @("個別利用許諾条件") },
  @{ typeId = 2; name = "condition2_note"; description = "金銭条件2 補足"; required = "false"; issueTypes = @("個別利用許諾条件") },

  @{ typeId = 1; name = "condition3_heading"; description = "金銭条件3 見出し"; required = "false"; issueTypes = @("個別利用許諾条件") },
  @{ typeId = 1; name = "condition3_region"; description = "金銭条件3 地域"; required = "false"; issueTypes = @("個別利用許諾条件") },
  @{ typeId = 1; name = "condition3_language"; description = "金銭条件3 言語"; required = "false"; issueTypes = @("個別利用許諾条件") },
  @{ typeId = 1; name = "condition3_calc_method"; description = "金銭条件3 計算方式"; required = "false"; issueTypes = @("個別利用許諾条件") },
  @{ typeId = 2; name = "condition3_summary"; description = "金銭条件3 概要"; required = "false"; issueTypes = @("個別利用許諾条件") },
  @{ typeId = 2; name = "condition3_formula"; description = "金銭条件3 計算式"; required = "false"; issueTypes = @("個別利用許諾条件") },
  @{ typeId = 1; name = "condition3_rate"; description = "金銭条件3 料率"; required = "false"; issueTypes = @("個別利用許諾条件") },
  @{ typeId = 2; name = "condition3_payment_terms"; description = "金銭条件3 支払条件"; required = "false"; issueTypes = @("個別利用許諾条件") },
  @{ typeId = 1; name = "condition3_mg_ag"; description = "金銭条件3 MG/AG"; required = "false"; issueTypes = @("個別利用許諾条件") },
  @{ typeId = 2; name = "condition3_note"; description = "金銭条件3 補足"; required = "false"; issueTypes = @("個別利用許諾条件") },

  @{ typeId = 1; name = "parent_issue_key"; description = "親課題キー"; required = "false"; issueTypes = @("納品リクエスト") },
  @{ typeId = 1; name = "item_no"; description = "明細番号"; required = "false"; issueTypes = @("納品リクエスト") },
  @{ typeId = 2; name = "delivery_note"; description = "納品備考"; required = "false"; issueTypes = @("納品リクエスト") },
  @{ typeId = 3; name = "delivered_amount"; description = "今回納品金額"; required = "false"; issueTypes = @("納品リクエスト") },

  @{ typeId = 1; name = "license_key"; description = "ライセンス課題キー"; required = "false"; issueTypes = @("製造案件") },
  @{ typeId = 1; name = "product_name"; description = "製品名"; required = "false"; issueTypes = @("製造案件") },
  @{ typeId = 1; name = "edition"; description = "版"; required = "false"; issueTypes = @("製造案件") },
  @{ typeId = 4; name = "completion_date"; description = "製造完了日"; required = "false"; issueTypes = @("製造案件") },
  @{ typeId = 3; name = "quantity"; description = "製造数量"; required = "false"; issueTypes = @("製造案件") },
  @{ typeId = 3; name = "msrp"; description = "MSRP"; required = "false"; issueTypes = @("製造案件") },
  @{ typeId = 3; name = "sample_quantity"; description = "サンプル数量"; required = "false"; issueTypes = @("製造案件") }
)

$customFieldsToPatch = @(
  @{ name = "remarks"; description = "備考"; required = "false"; issueTypes = @("業務委託基本契約", "発注書", "企画発注書") },
  @{ name = "contract_date"; description = "契約日"; required = "true"; issueTypes = @("業務委託基本契約", "NDA", "売買契約（当社買手）", "売買契約（当社売手・標準）", "売買契約（当社売手・保証金掛け売り）") },
  @{ name = "contract_period"; description = "契約期間"; required = "false"; issueTypes = @("NDA", "発注書", "企画発注書") },
  @{ name = "jurisdiction"; description = "管轄"; required = "true"; issueTypes = @("ライセンス契約", "NDA", "売買契約（当社買手）", "売買契約（当社売手・標準）", "売買契約（当社売手・保証金掛け売り）") },
  @{ name = "original_work"; description = "原著作物"; required = "true"; issueTypes = @("ライセンス契約", "個別利用許諾条件") }
)

function Ensure-OutputDir {
  if (-not (Test-Path -LiteralPath $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir | Out-Null
  }
}

function Backup-CurrentState {
  Ensure-OutputDir
  $issueTypes = Get-IssueTypes
  $customFields = Get-CustomFields
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $issueTypes | ConvertTo-Json -Depth 10 | Set-Content -Path (Join-Path $OutputDir "issueTypes-$stamp.json") -Encoding UTF8
  $customFields | ConvertTo-Json -Depth 10 | Set-Content -Path (Join-Path $OutputDir "customFields-$stamp.json") -Encoding UTF8
  Write-Host "バックアップ完了: $OutputDir"
}

function Show-Plan {
  $currentIssueTypes = Get-IssueTypes
  $currentFields = Get-CustomFields

  $missingIssueTypes = $issueTypesToAdd | Where-Object { $_.name -notin $currentIssueTypes.name }
  $fieldsToDelete = $currentFields | Where-Object { $_.name -in $obsoleteCustomFieldNames }
  $fieldsToAdd = $customFieldsToAdd | Where-Object { $_.name -notin $currentFields.name }
  $fieldsToPatch = $customFieldsToPatch | Where-Object { $_.name -in $currentFields.name }

  Write-Host "=== 課題タイプ追加候補 ==="
  $missingIssueTypes | ForEach-Object { Write-Host $_.name }
  Write-Host ""
  Write-Host "=== 削除対象カスタム属性 ==="
  $fieldsToDelete | Sort-Object name | ForEach-Object { Write-Host ("{0} (id={1})" -f $_.name, $_.id) }
  Write-Host ""
  Write-Host "=== 追加対象カスタム属性 ==="
  $fieldsToAdd | ForEach-Object { Write-Host $_.name }
  Write-Host ""
  Write-Host "=== PATCH対象カスタム属性 ==="
  $fieldsToPatch | ForEach-Object { Write-Host $_.name }
}

function Apply-IssueTypes {
  $currentIssueTypes = Get-IssueTypes
  foreach ($issueType in $issueTypesToAdd) {
    if ($issueType.name -in $currentIssueTypes.name) {
      Write-Host "skip issueType: $($issueType.name)"
      continue
    }
    Invoke-BacklogApi -Method POST -Path "/projects/$projectKey/issueTypes" -Form @{
      name = $issueType.name
      color = $issueType.color
      templateSummary = $issueType.templateSummary
      templateDescription = $issueType.templateDescription
    } | Out-Null
    Write-Host "added issueType: $($issueType.name)"
  }
}

function Apply-DeleteFields {
  $currentFields = Get-CustomFields
  $targets = $currentFields | Where-Object { $_.name -in $obsoleteCustomFieldNames } | Sort-Object name
  foreach ($field in $targets) {
    Invoke-BacklogApi -Method DELETE -Path "/projects/$projectKey/customFields/$($field.id)" | Out-Null
    Write-Host "deleted customField: $($field.name) id=$($field.id)"
  }
}

function Apply-AddFields {
  $currentFields = Get-CustomFields
  foreach ($field in $customFieldsToAdd) {
    if ($field.name -in $currentFields.name) {
      Write-Host "skip customField: $($field.name)"
      continue
    }

    $issueTypeIds = Resolve-IssueTypeIds -Names $field.issueTypes
    $form = @{
      typeId = [string]$field.typeId
      name = $field.name
      description = $field.description
      required = $field.required
      "applicableIssueTypes[]" = $issueTypeIds
    }

    try {
      Invoke-BacklogApi -Method POST -Path "/projects/$projectKey/customFields" -Form $form | Out-Null
      Write-Host "added customField: $($field.name)"
    } catch {
      Write-Host "failed customField: $($field.name)" -ForegroundColor Red
      Write-Host $_.Exception.Message -ForegroundColor Red
    }
  }
}

function Apply-PatchFields {
  $currentFields = Get-CustomFields
  foreach ($definition in $customFieldsToPatch) {
    $field = $currentFields | Where-Object { $_.name -eq $definition.name } | Select-Object -First 1
    if (-not $field) {
      Write-Host "skip patch missing customField: $($definition.name)"
      continue
    }

    $issueTypeIds = Resolve-IssueTypeIds -Names $definition.issueTypes
    $form = @{
      name = $definition.name
      description = $definition.description
      required = $definition.required
      "applicableIssueTypes[]" = $issueTypeIds
    }

    Invoke-BacklogApi -Method PATCH -Path "/projects/$projectKey/customFields/$($field.id)" -Form $form | Out-Null
    Write-Host "patched customField: $($definition.name)"
  }
}

switch ($Mode) {
  "backup" { Backup-CurrentState }
  "plan" { Show-Plan }
  "apply-issue-types" { Apply-IssueTypes }
  "apply-delete-fields" { Apply-DeleteFields }
  "apply-add-fields" { Apply-AddFields }
  "apply-patch-fields" { Apply-PatchFields }
}
