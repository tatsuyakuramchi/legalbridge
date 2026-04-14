param(
  [ValidateSet("backup", "plan", "apply")]
  [string]$Mode = "plan",
  [string]$OutputDir = "C:\Users\tatsuya.kuramochi\Desktop\legalbrigde-proto_GCP\tmp\backlog-migration",
  [string]$BacklogSpace = "",
  [string]$BacklogApiKey = "",
  [string]$BacklogProjectKey = ""
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $repoRoot ".env"
$cloudRunEnvFile = Join-Path $repoRoot "cloudrun.admin.env.yaml"

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

function Get-YamlScalarValue {
  param(
    [string]$Path,
    [string]$Key
  )

  if (-not (Test-Path -LiteralPath $Path)) {
    return ""
  }

  $line = Get-Content -Path $Path | Where-Object { $_ -match "^\s*$Key\s*:" } | Select-Object -First 1
  if (-not $line) {
    return ""
  }

  $value = ($line -replace "^\s*$Key\s*:\s*", "").Trim()
  if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
    return $value.Substring(1, $value.Length - 2)
  }
  return $value
}

if (-not $BacklogSpace) {
  $BacklogSpace = [string](Get-Item -Path "Env:BACKLOG_SPACE" -ErrorAction SilentlyContinue).Value
}
if (-not $BacklogSpace) {
  $BacklogSpace = Get-YamlScalarValue -Path $cloudRunEnvFile -Key "BACKLOG_SPACE"
}
if (-not $BacklogProjectKey) {
  $BacklogProjectKey = [string](Get-Item -Path "Env:BACKLOG_PROJECT_KEY" -ErrorAction SilentlyContinue).Value
}
if (-not $BacklogProjectKey) {
  $BacklogProjectKey = Get-YamlScalarValue -Path $cloudRunEnvFile -Key "BACKLOG_PROJECT_KEY"
}
if (-not $BacklogApiKey) {
  $BacklogApiKey = [string](Get-Item -Path "Env:BACKLOG_API_KEY" -ErrorAction SilentlyContinue).Value
}

if (-not $BacklogSpace) { throw "BACKLOG_SPACE が未設定です。-BacklogSpace または環境変数で指定してください。" }
if (-not $BacklogApiKey) { throw "BACKLOG_API_KEY が未設定です。-BacklogApiKey または環境変数で指定してください。" }
if (-not $BacklogProjectKey) { throw "BACKLOG_PROJECT_KEY が未設定です。-BacklogProjectKey または環境変数で指定してください。" }

$env:BACKLOG_SPACE = $BacklogSpace
$env:BACKLOG_API_KEY = $BacklogApiKey
$env:BACKLOG_PROJECT_KEY = $BacklogProjectKey

$baseUrl = "https://$BacklogSpace.backlog.com/api/v2"
$projectKey = $BacklogProjectKey

$FIELD_TYPE = @{
  text = 1
  multiline = 2
  numeric = 3
  date = 4
}

function Get-EnvOrDefault {
  param(
    [string]$EnvKey,
    [string]$DefaultValue
  )

  $configured = [string](Get-Item -Path "Env:$EnvKey" -ErrorAction SilentlyContinue).Value
  if ([string]::IsNullOrWhiteSpace($configured)) {
    return $DefaultValue
  }
  return $configured.Trim()
}

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
  param(
    [System.Collections.IEnumerable]$IssueTypeNames,
    [array]$CurrentIssueTypes
  )

  $ids = @()
  foreach ($name in $IssueTypeNames) {
    $matched = $CurrentIssueTypes | Where-Object { $_.name -eq $name } | Select-Object -First 1
    if (-not $matched) {
      throw "課題タイプが見つかりません: $name"
    }
    $ids += [string]$matched.id
  }
  return $ids
}

$issueTypesToEnsure = @(
  @{
    name = Get-EnvOrDefault "BACKLOG_ISSUE_TYPE_IP_OVERSEAS_MASTER" "海外IP契約（基本契約）"
    color = "#934981"
    templateSummary = ""
    templateDescription = ""
  },
  @{
    name = Get-EnvOrDefault "BACKLOG_ISSUE_TYPE_IP_OVERSEAS_AMENDMENT" "海外IP契約（変更合意）"
    color = "#666665"
    templateSummary = ""
    templateDescription = ""
  }
)

$issueTypeNda = Get-EnvOrDefault "BACKLOG_ISSUE_TYPE_NDA" "NDA"
$issueTypeOutsourcing = Get-EnvOrDefault "BACKLOG_ISSUE_TYPE_OUTSOURCING" "業務委託基本契約"
$issueTypeLicense = Get-EnvOrDefault "BACKLOG_ISSUE_TYPE_LICENSE" "ライセンス契約"
$issueTypeIpMaster = Get-EnvOrDefault "BACKLOG_ISSUE_TYPE_IP_OVERSEAS_MASTER" "海外IP契約（基本契約）"
$issueTypeIpAmendment = Get-EnvOrDefault "BACKLOG_ISSUE_TYPE_IP_OVERSEAS_AMENDMENT" "海外IP契約（変更合意）"
$issueTypeSalesBuyer = Get-EnvOrDefault "BACKLOG_ISSUE_TYPE_SALES_BUYER" "売買契約（当社買手）"
$issueTypeSalesSellerStandard = Get-EnvOrDefault "BACKLOG_ISSUE_TYPE_SALES_SELLER_STANDARD" "売買契約（当社売手・標準）"
$issueTypeSalesSellerCredit = Get-EnvOrDefault "BACKLOG_ISSUE_TYPE_SALES_SELLER_CREDIT" "売買契約（当社売手・保証金掛け売り）"
$issueTypePurchaseOrder = Get-EnvOrDefault "BACKLOG_ISSUE_TYPE_PURCHASE_ORDER" "発注書"
$issueTypePlanningOrder = Get-EnvOrDefault "BACKLOG_ISSUE_TYPE_PLANNING_ORDER" "企画発注書"
$issueTypePublishingOrder = Get-EnvOrDefault "BACKLOG_ISSUE_TYPE_PUBLISHING_ORDER" "出版発注書"
$issueTypeLicenseSchedule = Get-EnvOrDefault "BACKLOG_ISSUE_TYPE_LICENSE_SCHEDULE" "個別利用許諾条件"
$issueTypeDelivery = Get-EnvOrDefault "BACKLOG_ISSUE_TYPE_DELIVERY" "納品リクエスト"
$issueTypeMfg = Get-EnvOrDefault "BACKLOG_ISSUE_TYPE_MFG" "製造案件"
$issueTypeRoyaltySales = Get-EnvOrDefault "BACKLOG_ISSUE_TYPE_ROYALTY_SALES" "売上報告案件"

$primaryCommonIssueTypes = @(
  $issueTypeNda,
  $issueTypeOutsourcing,
  $issueTypeLicense,
  $issueTypeIpMaster,
  $issueTypeIpAmendment,
  $issueTypeSalesBuyer,
  $issueTypeSalesSellerStandard,
  $issueTypeSalesSellerCredit,
  $issueTypePurchaseOrder,
  $issueTypePlanningOrder,
  $issueTypePublishingOrder
)

$desiredCustomFields = @(
  @{
    envKey = "BACKLOG_FIELD_COUNTERPARTY"
    name = "相手方"
    description = "Backlog 上で任意に保持する相手方名。"
    typeId = $FIELD_TYPE.text
    required = "false"
    issueTypes = $primaryCommonIssueTypes
  },
  @{
    envKey = "BACKLOG_FIELD_DEADLINE"
    name = "希望期限"
    description = "Backlog 上で任意に保持する希望期限。"
    typeId = $FIELD_TYPE.date
    required = "false"
    issueTypes = $primaryCommonIssueTypes
  },
  @{
    envKey = "BACKLOG_FIELD_REMARKS"
    name = "備考"
    description = "Backlog 上で任意に保持する補足メモ。"
    typeId = $FIELD_TYPE.multiline
    required = "false"
    issueTypes = $primaryCommonIssueTypes
  },
  @{
    envKey = "BACKLOG_FIELD_CONTRACT_NO"
    name = "文書番号"
    description = "自動採番で保持する識別情報。"
    typeId = $FIELD_TYPE.text
    required = "false"
    issueTypes = $primaryCommonIssueTypes
  },
  @{
    envKey = "BACKLOG_FIELD_CONTRACT_DATE"
    name = "契約日・発注日"
    description = "契約系または発注系の主ヘッダ日付。"
    typeId = $FIELD_TYPE.date
    required = "false"
    issueTypes = @(
      $issueTypeNda,
      $issueTypeOutsourcing,
      $issueTypeLicense,
      $issueTypeIpMaster,
      $issueTypeIpAmendment,
      $issueTypeSalesBuyer,
      $issueTypeSalesSellerStandard,
      $issueTypeSalesSellerCredit,
      $issueTypePurchaseOrder,
      $issueTypePlanningOrder,
      $issueTypePublishingOrder
    )
  },
  @{
    envKey = "BACKLOG_FIELD_CONTRACT_PERIOD"
    name = "契約期間"
    description = "契約系で任意に保持する期間情報。"
    typeId = $FIELD_TYPE.text
    required = "false"
    issueTypes = @(
      $issueTypeNda,
      $issueTypeOutsourcing,
      $issueTypeLicense,
      $issueTypeIpMaster,
      $issueTypeIpAmendment,
      $issueTypeSalesBuyer,
      $issueTypeSalesSellerStandard,
      $issueTypeSalesSellerCredit
    )
  },
  @{
    envKey = "BACKLOG_FIELD_PROJECT_TITLE"
    name = "案件名"
    description = "発注書系で任意に保持する親課題ヘッダ。"
    typeId = $FIELD_TYPE.text
    required = "false"
    issueTypes = @(
      $issueTypePurchaseOrder,
      $issueTypePlanningOrder,
      $issueTypePublishingOrder
    )
  },
  @{
    envKey = "BACKLOG_FIELD_LICENSE_KEY"
    name = "親ライセンス課題キー"
    description = "関連するライセンス課題キー。"
    typeId = $FIELD_TYPE.text
    required = "false"
    issueTypes = @(
      $issueTypeLicenseSchedule,
      $issueTypeMfg,
      $issueTypeRoyaltySales
    )
  },
  @{
    envKey = "BACKLOG_FIELD_LICENSE_START"
    name = "許諾開始日"
    description = "個別利用許諾条件の開始日。"
    typeId = $FIELD_TYPE.date
    required = "false"
    issueTypes = @(
      $issueTypeLicenseSchedule
    )
  },
  @{
    envKey = "BACKLOG_FIELD_PARENT_ISSUE_KEY"
    name = "親課題キー"
    description = "納品リクエストの親参照。"
    typeId = $FIELD_TYPE.text
    required = "false"
    issueTypes = @(
      $issueTypeDelivery
    )
  },
  @{
    envKey = "BACKLOG_FIELD_ITEM_NO"
    name = "明細番号"
    description = "納品対象の識別子。"
    typeId = $FIELD_TYPE.text
    required = "false"
    issueTypes = @(
      $issueTypeDelivery
    )
  },
  @{
    envKey = "BACKLOG_FIELD_DELIVERY_NOTE"
    name = "納品備考"
    description = "納品リクエストの補足。"
    typeId = $FIELD_TYPE.multiline
    required = "false"
    issueTypes = @(
      $issueTypeDelivery
    )
  },
  @{
    envKey = "BACKLOG_FIELD_DELIVERED_AMOUNT"
    name = "今回納品金額"
    description = "納品リクエストで保持する今回納品金額。"
    typeId = $FIELD_TYPE.numeric
    required = "false"
    issueTypes = @(
      $issueTypeDelivery
    )
  },
  @{
    envKey = "BACKLOG_FIELD_FINAL_DEADLINE"
    name = "納期 / 校了予定"
    description = "納品管理で任意に保持する期日。"
    typeId = $FIELD_TYPE.date
    required = "false"
    issueTypes = @(
      $issueTypeDelivery
    )
  },
  @{
    envKey = "BACKLOG_FIELD_INSPECTION_DATE"
    name = "検収日"
    description = "納品リクエストで任意に保持する検収日。"
    typeId = $FIELD_TYPE.date
    required = "false"
    issueTypes = @(
      $issueTypeDelivery
    )
  },
  @{
    envKey = "BACKLOG_FIELD_PAYMENT_PLANNED_DATE"
    name = "支払予定日"
    description = "納品リクエストで任意に保持する支払予定日。"
    typeId = $FIELD_TYPE.date
    required = "false"
    issueTypes = @(
      $issueTypeDelivery
    )
  },
  @{
    envKey = "BACKLOG_FIELD_PRODUCT_NAME"
    name = "製品名 / 対象商品名"
    description = "製品名または売上報告の対象商品名。"
    typeId = $FIELD_TYPE.text
    required = "false"
    issueTypes = @(
      $issueTypeMfg,
      $issueTypeRoyaltySales
    )
  },
  @{
    envKey = "BACKLOG_FIELD_EDITION"
    name = "版"
    description = "利用許諾料計算で任意に保持する版情報。"
    typeId = $FIELD_TYPE.text
    required = "false"
    issueTypes = @(
      $issueTypeMfg
    )
  },
  @{
    envKey = "BACKLOG_FIELD_COMPLETION_DATE"
    name = "製造完了日"
    description = "製造ベース計算の基準日。"
    typeId = $FIELD_TYPE.date
    required = "false"
    issueTypes = @(
      $issueTypeMfg
    )
  },
  @{
    envKey = "BACKLOG_FIELD_QUANTITY"
    name = "数量"
    description = "製造数量。"
    typeId = $FIELD_TYPE.numeric
    required = "false"
    issueTypes = @(
      $issueTypeMfg
    )
  },
  @{
    envKey = "BACKLOG_FIELD_MSRP"
    name = "MSRP"
    description = "希望小売価格。"
    typeId = $FIELD_TYPE.numeric
    required = "false"
    issueTypes = @(
      $issueTypeMfg
    )
  },
  @{
    envKey = "BACKLOG_FIELD_SAMPLE_QUANTITY"
    name = "サンプル数量"
    description = "利用許諾料計算で任意に保持するサンプル数量。"
    typeId = $FIELD_TYPE.numeric
    required = "false"
    issueTypes = @(
      $issueTypeMfg
    )
  },
  @{
    envKey = "BACKLOG_FIELD_REPORT_PERIOD_START"
    name = "報告対象期間開始"
    description = "売上報告ベース計算で任意に保持する開始日。"
    typeId = $FIELD_TYPE.date
    required = "false"
    issueTypes = @(
      $issueTypeRoyaltySales
    )
  },
  @{
    envKey = "BACKLOG_FIELD_REPORT_PERIOD_END"
    name = "報告対象期間終了"
    description = "売上報告ベース計算の基準終了日。"
    typeId = $FIELD_TYPE.date
    required = "false"
    issueTypes = @(
      $issueTypeRoyaltySales
    )
  },
  @{
    envKey = "BACKLOG_FIELD_NET_SALES"
    name = "売上高・正味売上高"
    description = "売上報告ベース計算で保持する売上額。"
    typeId = $FIELD_TYPE.numeric
    required = "false"
    issueTypes = @(
      $issueTypeRoyaltySales
    )
  },
  @{
    envKey = "BACKLOG_FIELD_S1_REPORT_DUE"
    name = "報告期限"
    description = "報告期限。"
    typeId = $FIELD_TYPE.date
    required = "false"
    issueTypes = @(
      $issueTypeMfg,
      $issueTypeRoyaltySales
    )
  },
  @{
    envKey = "BACKLOG_FIELD_S1_PAYMENT_DUE"
    name = "支払期限"
    description = "支払期限。"
    typeId = $FIELD_TYPE.date
    required = "false"
    issueTypes = @(
      $issueTypeMfg,
      $issueTypeRoyaltySales
    )
  }
)

$obsoleteCustomFieldNames = @(
  "counterparty",
  "deadline",
  "remarks",
  "contract_no",
  "contract_date",
  "contract_period",
  "project_title",
  "license_key",
  "license_start",
  "parent_issue_key",
  "item_no",
  "delivery_note",
  "delivered_amount",
  "final_deadline",
  "inspection_date",
  "payment_planned_date",
  "product_name",
  "edition",
  "completion_date",
  "quantity",
  "sample_quantity",
  "report_period_start",
  "report_period_end",
  "net_sales",
  "report_due",
  "payment_due",
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
  "reviewer_department",
  "reviewer_name",
  "is_final_delivery",
  "amountchangereason",
  "hasamountchange",
  "hasrevision",
  "iscompleted",
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
  "period",
  "period_text",
  "revshare_basis",
  "revshare_note",
  "special_note",
  "unit_price",
  "contract_type",
  "counterparty_address",
  "counterparty_rep",
  "special_notes",
  "nda_purpose",
  "confidentiality_period",
  "jurisdiction",
  "original_work",
  "original_author",
  "credit_name",
  "succession_memorandum_date",
  "license_type_name",
  "territory",
  "calc_type_label",
  "royalty_rate_label",
  "payment_terms_text",
  "mg_ag_text",
  "material_code",
  "material_name",
  "material_rights_holder",
  "supervisor",
  "condition1_region_language_label",
  "condition1_calc_method",
  "condition1_formula",
  "condition1_base_price_label",
  "condition1_rate",
  "condition1_payment_terms",
  "condition1_mg_ag",
  "condition1_note",
  "condition2_heading",
  "condition2_region",
  "condition2_language",
  "condition2_calc_method",
  "condition2_summary",
  "condition2_formula",
  "condition2_share_rate",
  "condition2_payment_terms",
  "condition2_mg_ag",
  "condition2_note",
  "condition3_heading",
  "condition3_region",
  "condition3_language",
  "condition3_calc_method",
  "condition3_summary",
  "condition3_formula",
  "condition3_rate",
  "condition3_payment_terms",
  "condition3_mg_ag",
  "condition3_note",
  "product_scope",
  "delivery_location",
  "inspection_period_days",
  "payment_condition_summary",
  "warranty_period",
  "monthly_closing_day",
  "payment_due_day",
  "payment_method",
  "security_deposit_amount",
  "deposit_replenish_days"
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

function Compare-DesiredState {
  $currentIssueTypes = Get-IssueTypes
  $currentFields = Get-CustomFields

  $missingIssueTypes = $issueTypesToEnsure | Where-Object { $_.name -notin $currentIssueTypes.name }
  $fieldsToDelete = $currentFields | Where-Object { $_.name -in $obsoleteCustomFieldNames } | Sort-Object name
  $fieldsToAdd = $desiredCustomFields | Where-Object { $_.name -notin $currentFields.name }
  $fieldsToPatch = $desiredCustomFields | Where-Object { $_.name -in $currentFields.name }

  return @{
    issueTypes = @{
      add = $missingIssueTypes
    }
    customFields = @{
      delete = $fieldsToDelete
      add = $fieldsToAdd
      patch = $fieldsToPatch
    }
  }
}

function Show-Plan {
  $plan = Compare-DesiredState

  Write-Host "=== 追加する課題タイプ ==="
  if ($plan.issueTypes.add.Count -eq 0) {
    Write-Host "なし"
  } else {
    $plan.issueTypes.add | ForEach-Object { Write-Host $_.name }
  }

  Write-Host ""
  Write-Host "=== 削除するカスタム属性 ==="
  if ($plan.customFields.delete.Count -eq 0) {
    Write-Host "なし"
  } else {
    $plan.customFields.delete | ForEach-Object { Write-Host ("{0} (id={1})" -f $_.name, $_.id) }
  }

  Write-Host ""
  Write-Host "=== 追加するカスタム属性 ==="
  if ($plan.customFields.add.Count -eq 0) {
    Write-Host "なし"
  } else {
    $plan.customFields.add | ForEach-Object { Write-Host $_.name }
  }

  Write-Host ""
  Write-Host "=== 更新するカスタム属性 ==="
  if ($plan.customFields.patch.Count -eq 0) {
    Write-Host "なし"
  } else {
    $plan.customFields.patch | ForEach-Object { Write-Host $_.name }
  }
}

function Ensure-IssueTypes {
  param([array]$CurrentIssueTypes)

  foreach ($issueType in $issueTypesToEnsure) {
    if ($issueType.name -in $CurrentIssueTypes.name) {
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

function Remove-ObsoleteFields {
  param([array]$CurrentFields)

  $targets = $CurrentFields | Where-Object { $_.name -in $obsoleteCustomFieldNames } | Sort-Object name
  foreach ($field in $targets) {
    Invoke-BacklogApi -Method DELETE -Path "/projects/$projectKey/customFields/$($field.id)" | Out-Null
    Write-Host "deleted customField: $($field.name) id=$($field.id)"
  }
}

function Upsert-DesiredFields {
  param(
    [array]$CurrentIssueTypes,
    [array]$CurrentFields
  )

  foreach ($definition in $desiredCustomFields) {
    $issueTypeIds = Resolve-IssueTypeIds -IssueTypeNames $definition.issueTypes -CurrentIssueTypes $CurrentIssueTypes
    $form = @{
      name = $definition.name
      description = $definition.description
      required = $definition.required
      "applicableIssueTypes[]" = $issueTypeIds
    }

    $existing = $CurrentFields | Where-Object { $_.name -eq $definition.name } | Select-Object -First 1
    if (-not $existing) {
      $form.typeId = [string]$definition.typeId
      Invoke-BacklogApi -Method POST -Path "/projects/$projectKey/customFields" -Form $form | Out-Null
      Write-Host "added customField: $($definition.name)"
      continue
    }

    Invoke-BacklogApi -Method PATCH -Path "/projects/$projectKey/customFields/$($existing.id)" -Form $form | Out-Null
    Write-Host "patched customField: $($definition.name)"
  }
}

function Apply-Changes {
  Backup-CurrentState
  $currentIssueTypes = Get-IssueTypes
  Ensure-IssueTypes -CurrentIssueTypes $currentIssueTypes

  $refreshedIssueTypes = Get-IssueTypes
  $currentFields = Get-CustomFields
  Remove-ObsoleteFields -CurrentFields $currentFields

  $refreshedFields = Get-CustomFields
  Upsert-DesiredFields -CurrentIssueTypes $refreshedIssueTypes -CurrentFields $refreshedFields
}

switch ($Mode) {
  "backup" { Backup-CurrentState }
  "plan" { Show-Plan }
  "apply" { Apply-Changes }
}
