# Slack Modal Minimum Fields Final

## 目的

Slack モーダルで受ける項目の確定版をまとめる。

- Slack は `起票に必要な最小ヘッダ` だけ受ける
- 詳細条件、期日、運用条件は Backlog を正本にする
- Local / DB は補助と文書生成に限定する

## 共通

全種別で共通して扱う基本項目。

| 項目 | blockId | 必須 | 備考 |
|---|---|---|---|
| 依頼種別 | `contract_type` | 必須 | 起票先の入口種別 |
| 件名 | `summary` | 必須 | Backlog 課題件名 |
| 依頼内容 | `notes` | 必須 | 起票本文の最低限情報 |
| 希望納期 | `deadline` | 条件付き | 契約系中心。発注・計算では Backlog 主体 |
| 相手先名 | `counterparty` | 条件付き | 契約系、発注書系などヘッダが必要な種別のみ |
| 登録番号 | `registration_number` | 条件付き | 契約・売買系のみ |
| 添付ファイル | `request_attachments` | 任意 | レビュー依頼、相談など |
| 備考 | `remarks` | 任意 | 補足メモ |

## 依頼種別ごとの最小項目

### 法務相談

| 項目 | blockId | 必須 |
|---|---|---|
| 相手方・相談先 | `counterparty` | 任意 |
| 相談背景・補足 | `remarks` | 任意 |
| 相談内容・レビュー観点 | `notes` | 任意 |

### NDA

| 項目 | blockId | 必須 |
|---|---|---|
| 契約日 | `contract_date` | 必須 |
| 秘密保持の目的 | `nda_purpose` | 必須 |
| 契約期間 | `contract_period` | 必須 |
| 秘密保持期間 | `confidentiality_period` | 任意 |

Backlog 補完:

- `jurisdiction`

### 業務委託基本契約

| 項目 | blockId | 必須 |
|---|---|---|
| 契約日 | `contract_date` | 必須 |
| 業務概要・前提情報 | `notes` | 任意 |

Backlog 補完:

- `contract_period`
- `jurisdiction`

### ライセンス契約

| 項目 | blockId | 必須 |
|---|---|---|
| 契約日 | `contract_date` | 任意 |
| 原著作物 | `original_work` | 必須 |
| 管轄裁判所 | `jurisdiction` | 必須 |

Backlog 補完:

- `original_author`
- `credit_name`
- `succession_memorandum_date`
- `contract_period`

### 個別利用許諾条件

| 項目 | blockId | 必須 |
|---|---|---|
| 親ライセンス課題キー | `license_issue_key` | 必須 |
| 許諾区分 | `license_type_name` | 必須 |
| 対象作品・原著作物 | `original_work` | 必須 |
| 許諾開始日 | `license_start` | 必須 |
| 許諾地域・言語 | `territory` | 任意 |

Backlog / Local 補完:

- `calculation_method_label`
- `rate_label`
- `payment_terms_label`
- `mg_ag_label`
- `material_*`
- `money1_*`
- `money2_*`
- `money3_*`

### 売買契約（当社買手）

| 項目 | blockId | 必須 |
|---|---|---|
| 契約日 | `contract_date` | 必須 |
| 商品範囲 | `product_scope` | 必須 |
| 支払条件概要 | `payment_condition_summary` | 必須 |
| 補足メモ | `notes` | 任意 |

Backlog 補完:

- `delivery_location`
- `inspection_period_days`
- `warranty_period`
- `jurisdiction`

### 売買契約（当社売手・標準）

| 項目 | blockId | 必須 |
|---|---|---|
| 契約日 | `contract_date` | 必須 |
| 商品範囲 | `product_scope` | 必須 |
| 支払条件概要 | `payment_condition_summary` | 必須 |
| 補足メモ | `notes` | 任意 |

Backlog 補完:

- `monthly_closing_day`
- `payment_due_day`
- `payment_method`
- `warranty_period`
- `jurisdiction`

### 売買契約（当社売手・保証金掛け売り）

| 項目 | blockId | 必須 |
|---|---|---|
| 契約日 | `contract_date` | 必須 |
| 商品範囲 | `product_scope` | 必須 |
| 支払条件概要 | `payment_condition_summary` | 必須 |
| 保証金額 | `security_deposit_amount` | 必須 |
| 保証金補充期限 | `deposit_replenish_days` | 必須 |
| 補足メモ | `notes` | 任意 |

Backlog 補完:

- `monthly_closing_day`
- `payment_due_day`
- `payment_method`
- `warranty_period`
- `jurisdiction`

### 発注書

| 項目 | blockId | 必須 |
|---|---|---|
| 案件名 | `project_title` | 必須 |
| 発注概要 | `order_summary` | 任意 |

Backlog 補完:

- `contract_date`

### 企画発注書

| 項目 | blockId | 必須 |
|---|---|---|
| 案件名 | `project_title` | 必須 |

Backlog 補完:

- `contract_date`
- `master_contract_ref`

### 出版発注書

| 項目 | blockId | 必須 |
|---|---|---|
| 案件名 | `project_title` | 必須 |
| マスター契約参照 | `master_contract_ref` | 任意 |
| 進行概要 | `order_summary` | 任意 |

Backlog 補完:

- `contract_date`
- `final_deadline`
- `inspection_date`
- `payment_planned_date`

### 納品リクエスト

| 項目 | blockId | 必須 |
|---|---|---|
| 親課題キー | `parent_issue_key` | 必須 |
| 明細番号 | `item_no` | 必須 |
| 納品備考 | `delivery_note` | 任意 |

Backlog 補完:

- `delivered_amount`
- `inspection_date`
- `payment_planned_date`

### 利用許諾料計算（製造ベース）

| 項目 | blockId | 必須 |
|---|---|---|
| 紐付けライセンス課題キー | `license_issue_key` | 必須 |
| 製品名 | `product_name` | 必須 |
| 製造完了日 | `completion_date` | 必須 |
| 製造数量 | `quantity` | 必須 |
| MSRP | `msrp` | 必須 |
| 備考 | `remarks` | 任意 |

Backlog 補完:

- `edition`
- `sample_quantity`
- `report_due`
- `payment_due`

### 利用許諾料計算（売上報告ベース）

| 項目 | blockId | 必須 |
|---|---|---|
| 紐付けライセンス課題キー | `license_issue_key` | 必須 |
| 製品名 | `product_name` | 必須 |
| 報告対象期間終了 | `report_period_end` | 必須 |
| 売上高 | `sales_amount` | 必須 |
| 備考 | `remarks` | 任意 |

Backlog 補完:

- `report_period_start`
- `received_amount`
- `sales_quantity`
- `report_due`
- `payment_due`

## 運用上の原則

- Slack では `課題を立てるための最小ヘッダ` のみ受ける
- 期日、金額詳細、検収・支払運用は Backlog 側を正本にする
- ローカルUIは Backlog 課題キー起点で詳細補完と文書生成を行う
