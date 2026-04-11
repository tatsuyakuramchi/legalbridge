# Backlog Setup Checklist

## 目的

Slack 起点の文書作成と後続申請を運用するために、Backlog 側で先に作成すべき課題タイプとカスタム属性を整理する。

## 先に作る課題タイプ

- NDA
- 業務委託基本契約
- ライセンス契約
- 個別利用許諾条件
- 法務相談
- 売買契約（当社買手）
- 売買契約（当社売手・標準）
- 売買契約（当社売手・保証金掛け売り）
- 発注書
- 企画発注書
- 出版発注書
- 納品リクエスト
- 製造案件

## 共通属性

- `contract_type`
- `counterparty`
- `contract_no`
- `counterparty_address`
- `counterparty_rep`
- `special_notes`
- `remarks`
- `deadline`

## 優先度A: 先に必須で作る属性

この章は `Slack モーダルの最小入力で起票を成立させるために必要な属性` を指す。

### NDA

- `contract_date`
- `contract_period`
- `confidentiality_period`
- `nda_purpose`

### 業務委託契約

- `contract_date`
- `remarks`

### ライセンス契約

- `original_work`
- `contract_date`
- `jurisdiction`

### 個別利用許諾条件

- `license_key`
- `license_type_name`
- `original_work`
- `license_start`
- `territory`

### 発注書 / 企画発注書 / 出版発注書

- `project_title`
- `payment_condition_summary`  `発注書のみ`
- `master_contract_ref`  `出版発注書のみ`
- `remarks`  `出版発注書のみ`

### 出版運用の追加期限属性

- `inspection_date`
- `payment_planned_date`
- `first_proof_deadline`
- `second_proof_deadline`
- `final_deadline`

### 納品リクエスト

- `parent_issue_key`
- `item_no`
- `delivery_note`
- `final_deadline`

### 製造案件

- `license_key`
- `product_name`
- `completion_date`
- `quantity`
- `msrp`

### 利用許諾料計算の期限属性

- `report_due`
- `payment_due`
- `report_period_end`  `売上報告ベース`
- `net_sales`  `売上報告ベース`

## 優先度B: 個別利用許諾条件の拡張属性

以下は Slack モーダルの初回起票では使わず、必要に応じて Backlog / Local 側で補完する。
起動時チェックでも `warning` 扱いにとどめ、`blocking issue` にはしない。

また、次の項目も優先度Bとして扱う。

- `jurisdiction`  `NDA`
- `contract_period`  `業務委託基本契約`
- `jurisdiction`  `業務委託基本契約`
- `original_author`
- `credit_name`
- `承継覚書日付`
- `delivery_location`
- `inspection_period_days`
- `warranty_period`
- `monthly_closing_day`
- `payment_due_day`
- `payment_method`
- `inspection_date`
- `payment_planned_date`
- `received_amount`

### 素材情報

- `material_code`
- `material_name`
- `material_rights_holder`
- `supervisor`

### 金銭条件1

- `condition1_region_language_label`
- `condition1_calc_method`
- `condition1_formula`
- `condition1_base_price_label`
- `condition1_rate`
- `condition1_payment_terms`
- `condition1_mg_ag`
- `condition1_note`

### 金銭条件2

- `condition2_heading`
- `condition2_region`
- `condition2_language`
- `condition2_calc_method`
- `condition2_summary`
- `condition2_formula`
- `condition2_share_rate`
- `condition2_payment_terms`
- `condition2_mg_ag`
- `condition2_note`

### 金銭条件3

- `condition3_heading`
- `condition3_region`
- `condition3_language`
- `condition3_calc_method`
- `condition3_summary`
- `condition3_formula`
- `condition3_rate`
- `condition3_payment_terms`
- `condition3_mg_ag`
- `condition3_note`

## 運用メモ

- `special_terms` は使わず、`special_notes` に統一する
- `remarks` は文書表示用か内部メモ用かを分ける
- 発注書系の明細は Backlog に詰め込まず、必要に応じて CSV / DB を使う
- 発注明細の納期アラートは DB 上の `OrderItem.latestDueDate` を基準に送る
- 出版発注書は `親課題 = 出版発注書 / 子課題 = 納品リクエスト(1明細1課題)` を前提にする
- `検収日 / 支払予定日 / 報告期限 / 支払期限` は Backlog を正本にする
- 納品リクエストと製造案件は Slack の後続申請ショートカットから起票する想定
- `法務相談` は文書生成対象外の相談課題として運用する
- 投稿チャンネル、上長ID、承認（押印）ID、実行（押印）ID は Backlog ではなく管理UIのワークフロー設定で部署ごとに管理する
- 部署候補は Staff テーブルの `department` から読み込む
- 売買契約は `当社買手 / 当社売手・標準 / 当社売手・保証金掛け売り` の3課題タイプで分ける
- `個別利用許諾条件` は独立課題タイプとしても運用し、`ライセンス基本契約 + 個別利用許諾条件` を同時生成するケースと、`個別利用許諾条件` 単独生成の両方を許容する

## `.env` 設定手順

1. Backlog で各属性を作成する
2. 属性 ID を確認する
3. `.env.example` の対応する `BACKLOG_FIELD_*` に転記する
4. 課題タイプ名も `.env` に Backlog 実名で設定する

## 今回の実施順

今回の追加は次の順で進める。

1. `納品リクエスト`
   - `inspection_date`
   - `payment_planned_date`
   - `final_deadline`
2. `製造案件 / 売上報告案件`
   - `report_due`
   - `payment_due`
   - `received_amount`

補足:

- `report_due / payment_due` は既存の `BACKLOG_FIELD_S1_REPORT_DUE / BACKLOG_FIELD_S1_PAYMENT_DUE` を優先利用する
- `初校締切 / 再校締切` は次フェーズで追加する
- `calc_type_label / royalty_rate_label / payment_terms_text / mg_ag_text` は追加しない

## 追加で確認したい点

- 売買契約の各課題タイプ名を Backlog 上で最終確定する
- `ライセンス契約` 起票時に `個別利用許諾条件` を同時生成するかを Slack 側で分岐させる
