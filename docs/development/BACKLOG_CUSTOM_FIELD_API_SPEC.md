# Backlog Custom Field API Spec

## 目的

Backlog のカスタム属性を API 連携で追加するときに、そのまま実装・設定に使える仕様を固定する。

対象は次の 3 系統。

- 出版発注書
- 納品リクエスト
- 利用許諾料計算

## 設計原則

- `親課題` はヘッダ中心
- `子課題` は締切と実務状態中心
- `1明細1課題`
- `納期 / 検収日 / 支払予定日 / 報告期限 / 支払期限` は Backlog を正本にする
- Local / DB は帳票生成、明細保持、補助履歴に徹する
- `個別利用許諾条件` は旧表示系フィールドを使わず、詳細条件は `CONDITION1_* / CONDITION2_* / CONDITION3_*` に統一する

## API 登録の優先順位

### 優先度A

最初に追加したい属性。

1. `検収日`
2. `支払予定日`
3. `報告期限`
4. `支払期限`

### 優先度B

出版進行をより細かく管理したい場合に追加。

1. `初校締切`
2. `再校締切`
3. `校了予定`

## 今回の確定追加対象

今回のフェーズで先に追加する対象は次の 6 項目に固定する。

1. `BACKLOG_FIELD_INSPECTION_DATE`
2. `BACKLOG_FIELD_PAYMENT_PLANNED_DATE`
3. `BACKLOG_FIELD_FINAL_DEADLINE`
4. `BACKLOG_FIELD_S1_REPORT_DUE`
5. `BACKLOG_FIELD_S1_PAYMENT_DUE`
6. `BACKLOG_FIELD_RECEIVED_AMOUNT`

補足:

- `初校締切 / 再校締切` は次フェーズに回す
- `個別利用許諾条件` の旧表示系フィールドは追加しない
- `個別利用許諾条件` の詳細は `CONDITION1_* / CONDITION2_* / CONDITION3_*` で揃える

## Slack 最小入力に対応する必須属性

Slack モーダルの確定版最小項目に合わせて、`まず必須で揃える属性` をここで固定する。

### 主契約系

| 課題タイプ | 必須属性 |
|---|---|
| NDA | `contract_date`, `nda_purpose`, `contract_period`, `confidentiality_period` |
| 業務委託基本契約 | `contract_date`, `remarks` |
| ライセンス契約 | `contract_date`, `original_work`, `jurisdiction` |
| 売買契約（当社買手） | `contract_date`, `product_scope`, `payment_condition_summary`, `notes` |
| 売買契約（当社売手・標準） | `contract_date`, `product_scope`, `payment_condition_summary`, `notes` |
| 売買契約（当社売手・保証金掛け売り） | `contract_date`, `product_scope`, `payment_condition_summary`, `security_deposit_amount`, `deposit_replenish_days`, `notes` |

### 発注・納品系

| 課題タイプ | 必須属性 |
|---|---|
| 発注書 | `project_title`, `payment_condition_summary` |
| 企画発注書 | `project_title` |
| 出版発注書 | `project_title`, `master_contract_ref`, `remarks` |
| 納品リクエスト | `parent_issue_key`, `item_no`, `delivery_note`, `final_deadline` |

### ライセンス後続系

| 課題タイプ | 必須属性 |
|---|---|
| 個別利用許諾条件 | `license_key`, `license_type_name`, `original_work`, `license_start`, `territory` |
| 製造案件 | `license_key`, `product_name`, `completion_date`, `quantity`, `msrp`, `report_due`, `payment_due` |
| 売上報告案件 | `license_key`, `product_name`, `report_period_end`, `net_sales`, `report_due`, `payment_due` |

補足:

- `notes` や `remarks` は本文・補足メモの受け皿として必須扱いにしてよい
- `inspection_date`, `payment_planned_date`, `received_amount` は後続運用で重要だが、初回起票の blocking 条件にはしない
- `delivery_note` は一括検収・帳票生成へつなぐため、`納品リクエスト` では持っておく

## 出版発注書

### 親課題

課題タイプ:

- `出版発注書`

推奨属性:

| `.env` | 推奨属性名 | 型 | 必須 | 用途 |
|---|---|---|---|---|
| `BACKLOG_FIELD_ORDER_DATE` | `order_date` | 日付 | 任意 | 発注日 |
| `BACKLOG_FIELD_PROJECT_TITLE` | `project_title` | 文字列 | 必須 | 案件名 |
| `BACKLOG_FIELD_MASTER_CONTRACT_REF` | `master_contract_ref` | 文字列 | 任意 | マスター契約参照 |
| `BACKLOG_FIELD_COUNTERPARTY` | `counterparty` | 文字列 | 必須 | 相手方 |
| `BACKLOG_FIELD_REMARKS` | `remarks` | 複数行文字列 | 任意 | 進行概要・全体備考 |

### 子課題

課題タイプ:

- `納品リクエスト`

推奨属性:

| `.env` | 推奨属性名 | 型 | 必須 | 用途 |
|---|---|---|---|---|
| `BACKLOG_FIELD_PARENT_ISSUE_KEY` | `parent_issue_key` | 文字列 | 必須 | 親出版発注書キー |
| `BACKLOG_FIELD_ITEM_NO` | `item_no` | 数値 or 文字列 | 必須 | 明細番号 |
| `BACKLOG_FIELD_ITEM_NAME` | `item_name` | 文字列 | 任意 | 成果物名 |
| `BACKLOG_FIELD_DELIVERY_NOTE` | `delivery_note` | 複数行文字列 | 任意 | 業務概要・納品備考 |
| `BACKLOG_FIELD_DELIVERED_AMOUNT` | `delivered_amount` | 数値 | 任意 | 今回納品金額 |
| `BACKLOG_FIELD_FINAL_DEADLINE` | `final_deadline` | 日付 | 必須 | 納期または校了予定 |
| `BACKLOG_FIELD_INSPECTION_DATE` | `inspection_date` | 日付 | 検収時必須 | 検収書の日付 |
| `BACKLOG_FIELD_PAYMENT_PLANNED_DATE` | `payment_planned_date` | 日付 | 任意 | 支払予定日 |

### 出版進行の追加属性

| `.env` | 推奨属性名 | 型 | 必須 | 用途 |
|---|---|---|---|---|
| `BACKLOG_FIELD_FIRST_PROOF_DEADLINE` | `first_proof_deadline` | 日付 | 任意 | 初校締切 |
| `BACKLOG_FIELD_SECOND_PROOF_DEADLINE` | `second_proof_deadline` | 日付 | 任意 | 再校締切 |
| `BACKLOG_FIELD_FINAL_DEADLINE` | `final_deadline` | 日付 | 任意 | 校了予定 |

## 利用許諾料計算

### 製造ベース

課題タイプ:

- `製造案件`

推奨属性:

| `.env` | 推奨属性名 | 型 | 必須 | 用途 |
|---|---|---|---|---|
| `BACKLOG_FIELD_LICENSE_KEY` | `license_key` | 文字列 | 必須 | 紐付けライセンス課題キー |
| `BACKLOG_FIELD_PRODUCT_NAME` | `product_name` | 文字列 | 必須 | 製品名 |
| `BACKLOG_FIELD_COMPLETION_DATE` | `completion_date` | 日付 | 必須 | 製造完了日 |
| `BACKLOG_FIELD_QUANTITY` | `quantity` | 数値 | 必須 | 製造数量 |
| `BACKLOG_FIELD_MSRP` | `msrp` | 数値 | 必須 | 基準価格 |
| `BACKLOG_FIELD_SAMPLE_QUANTITY` | `sample_quantity` | 数値 | 任意 | サンプル数 |
| `BACKLOG_FIELD_S1_REPORT_DUE` | `report_due` | 日付 | 必須 | 報告期限 |
| `BACKLOG_FIELD_S1_PAYMENT_DUE` | `payment_due` | 日付 | 必須 | 支払期限 |

### 売上報告ベース

課題タイプ:

- `売上報告案件`

推奨属性:

| `.env` | 推奨属性名 | 型 | 必須 | 用途 |
|---|---|---|---|---|
| `BACKLOG_FIELD_LICENSE_KEY` | `license_key` | 文字列 | 必須 | 紐付けライセンス課題キー |
| `BACKLOG_FIELD_PRODUCT_NAME` | `product_name` | 文字列 | 必須 | 対象商品・報告単位名 |
| `BACKLOG_FIELD_REPORT_PERIOD_START` | `report_period_start` | 日付 | 必須 | 報告対象期間開始 |
| `BACKLOG_FIELD_REPORT_PERIOD_END` | `report_period_end` | 日付 | 必須 | 報告対象期間終了 |
| `BACKLOG_FIELD_NET_SALES` | `net_sales` | 数値 | 条件付き必須 | 売上高・正味売上高 |
| `BACKLOG_FIELD_RECEIVED_AMOUNT` | `received_amount` | 数値 | 条件付き必須 | 受領額 |
| `BACKLOG_FIELD_S1_REPORT_DUE` | `report_due` | 日付 | 必須 | 報告期限 |
| `BACKLOG_FIELD_S1_PAYMENT_DUE` | `payment_due` | 日付 | 必須 | 支払期限 |

## 命名ルール

- 日付属性は `_date` または `_deadline` で終える
- 期限起点の値は `*_deadline`
- 実績日は `*_date`
- 支払予定は `payment_planned_date`
- 報告期限は `report_due`
- 支払期限は `payment_due`

## `.env` 追加候補

```env
BACKLOG_ISSUE_TYPE_PUBLISHING_ORDER=出版発注書
BACKLOG_FIELD_INSPECTION_DATE=
BACKLOG_FIELD_PAYMENT_PLANNED_DATE=
BACKLOG_FIELD_FIRST_PROOF_DEADLINE=
BACKLOG_FIELD_SECOND_PROOF_DEADLINE=
BACKLOG_FIELD_FINAL_DEADLINE=
BACKLOG_FIELD_RECEIVED_AMOUNT=
```

今回このまま `.env` に追加する候補:

```env
BACKLOG_FIELD_INSPECTION_DATE=
BACKLOG_FIELD_PAYMENT_PLANNED_DATE=
BACKLOG_FIELD_FINAL_DEADLINE=
BACKLOG_FIELD_RECEIVED_AMOUNT=
```

既存キーを継続利用するもの:

```env
BACKLOG_FIELD_S1_REPORT_DUE=
BACKLOG_FIELD_S1_PAYMENT_DUE=
```

補足:

- `BACKLOG_FIELD_CALC_TYPE_LABEL`
- `BACKLOG_FIELD_ROYALTY_RATE_LABEL`
- `BACKLOG_FIELD_PAYMENT_TERMS_TEXT`
- `BACKLOG_FIELD_MG_AG_TEXT`

は新設しない前提で進める。

## API 登録時のメモ

- 属性の `name` はこの仕様の `推奨属性名` にできるだけ合わせる
- Description には「何の期日か」「親課題か子課題か」を書く
- `検収日` と `支払予定日` は `納品リクエスト` に作る
- `報告期限` と `支払期限` は `製造案件 / 売上報告案件` の両方で使えるように揃える

## 実装側の追従順

1. Backlog に属性追加
2. `.env` に ID 反映
3. `configValidator` に必須属性を追加
4. Local / Slack から書き込む処理を接続
5. 運用チェックリスト更新
