# Backlog Field Mapping Guide

## 目的

Slack フォーム、Backlog カスタム属性、テンプレート変数、`.env` の対応を揃えるための一覧。

## 運用優先度

- `優先度A`: Slack 最小入力の起票を成立させるため必須
- `優先度B`: 起票後に Backlog / Local 側で補完すればよい

## 優先ルール

- Backlog の実カスタム属性名を優先する
- `.env` の `BACKLOG_FIELD_*` はその属性 ID を指す
- 同じ意味の値は 1 つの Backlog 属性に寄せる
- テンプレート変数への整形はアプリ側で行う

## NDA

| 用途 | Backlog属性名 | .env |
|---|---|---|
| 契約日 `優先度A` | `contract_date` | `BACKLOG_FIELD_CONTRACT_DATE` |
| 契約期間 `優先度A` | `contract_period` | `BACKLOG_FIELD_CONTRACT_PERIOD` |
| 秘密保持期間 `優先度A` | `confidentiality_period` | `BACKLOG_FIELD_CONFIDENTIALITY_PERIOD` |
| 秘密保持の目的 `優先度A` | `nda_purpose` | `BACKLOG_FIELD_NDA_PURPOSE` |
| 管轄裁判所 `優先度B` | `jurisdiction` | `BACKLOG_FIELD_JURISDICTION` |

## 業務委託基本契約

| 用途 | Backlog属性名 | .env |
|---|---|---|
| 契約日 `優先度A` | `contract_date` | `BACKLOG_FIELD_CONTRACT_DATE` |
| 備考 `優先度A` | `remarks` | `BACKLOG_FIELD_REMARKS` |
| 契約期間 `優先度B` | `contract_period` | `BACKLOG_FIELD_CONTRACT_PERIOD` |
| 管轄裁判所 `優先度B` | `jurisdiction` | `BACKLOG_FIELD_JURISDICTION` |

## ライセンス契約

| 用途 | Backlog属性名 | .env |
|---|---|---|
| 契約日 `優先度A` | `contract_date` | `BACKLOG_FIELD_CONTRACT_DATE` |
| 原著作物 `優先度A` | `original_work` | `BACKLOG_FIELD_ORIGINAL_WORK` |
| 管轄裁判所 `優先度A` | `jurisdiction` | `BACKLOG_FIELD_JURISDICTION` |
| 原著作者 `優先度B` | `original_author` | `BACKLOG_FIELD_ORIGINAL_AUTHOR` |
| クレジット表記 `優先度B` | `credit_name` | `BACKLOG_FIELD_CREDIT_NAME` |
| 承継覚書日付 `優先度B` | `承継覚書日付` | `BACKLOG_FIELD_SUCCESSION_MEMORANDUM_DATE` |
| 特約・特記事項 `優先度B` | `special_notes` | `BACKLOG_FIELD_SPECIAL_NOTES` |

## 個別利用許諾条件

### Slack 初回起票で使う最小項目

| 用途 | Backlog属性名 | .env |
|---|---|---|
| 親ライセンス課題キー | `license_key` | `BACKLOG_FIELD_LICENSE_KEY` |
| ライセンス種別名 | `license_type_name` | `BACKLOG_FIELD_LICENSE_TYPE_NAME` |
| 原著作物 | `original_work` | `BACKLOG_FIELD_ORIGINAL_WORK` |
| 許諾開始日 | `license_start` | `BACKLOG_FIELD_LICENSE_START` |
| 地域・言語 | `territory` | `BACKLOG_FIELD_TERRITORY` |
| 特記事項 | `special_notes` | `BACKLOG_FIELD_SPECIAL_NOTES` |

Slack モーダルではここまでを対象にし、以下は起票後に Backlog / Local 側で補完する。旧表示系フィールド
`calc_type_label` / `royalty_rate_label` / `payment_terms_text` / `mg_ag_text`
は新設しない前提で、正規項目は `CONDITION1_*` 以降に統一する。

### 拡張属性

#### 素材情報

| 用途 | .env |
|---|---|
| 素材番号 | `BACKLOG_FIELD_MATERIAL_CODE` |
| 素材名 | `BACKLOG_FIELD_MATERIAL_NAME` |
| 素材権利者 | `BACKLOG_FIELD_MATERIAL_RIGHTS_HOLDER` |
| 監修者 | `BACKLOG_FIELD_SUPERVISOR` |

#### 金銭条件1

| 用途 | .env |
|---|---|
| 地域・言語 | `BACKLOG_FIELD_CONDITION1_REGION_LANGUAGE_LABEL` |
| 計算方式 | `BACKLOG_FIELD_CONDITION1_CALC_METHOD` |
| 計算式 | `BACKLOG_FIELD_CONDITION1_FORMULA` |
| 基準価格ラベル | `BACKLOG_FIELD_CONDITION1_BASE_PRICE_LABEL` |
| 料率 | `BACKLOG_FIELD_CONDITION1_RATE` |
| 支払条件 | `BACKLOG_FIELD_CONDITION1_PAYMENT_TERMS` |
| MG/AG | `BACKLOG_FIELD_CONDITION1_MG_AG` |
| 補足 | `BACKLOG_FIELD_CONDITION1_NOTE` |

#### 金銭条件2

| 用途 | .env |
|---|---|
| 見出し | `BACKLOG_FIELD_CONDITION2_HEADING` |
| 地域 | `BACKLOG_FIELD_CONDITION2_REGION` |
| 言語 | `BACKLOG_FIELD_CONDITION2_LANGUAGE` |
| 計算方式 | `BACKLOG_FIELD_CONDITION2_CALC_METHOD` |
| 概要 | `BACKLOG_FIELD_CONDITION2_SUMMARY` |
| 計算式 | `BACKLOG_FIELD_CONDITION2_FORMULA` |
| 分配率 | `BACKLOG_FIELD_CONDITION2_SHARE_RATE` |
| 支払条件 | `BACKLOG_FIELD_CONDITION2_PAYMENT_TERMS` |
| MG/AG | `BACKLOG_FIELD_CONDITION2_MG_AG` |
| 補足 | `BACKLOG_FIELD_CONDITION2_NOTE` |

#### 金銭条件3

| 用途 | .env |
|---|---|
| 見出し | `BACKLOG_FIELD_CONDITION3_HEADING` |
| 地域 | `BACKLOG_FIELD_CONDITION3_REGION` |
| 言語 | `BACKLOG_FIELD_CONDITION3_LANGUAGE` |
| 計算方式 | `BACKLOG_FIELD_CONDITION3_CALC_METHOD` |
| 概要 | `BACKLOG_FIELD_CONDITION3_SUMMARY` |
| 計算式 | `BACKLOG_FIELD_CONDITION3_FORMULA` |
| 料率 | `BACKLOG_FIELD_CONDITION3_RATE` |
| 支払条件 | `BACKLOG_FIELD_CONDITION3_PAYMENT_TERMS` |
| MG/AG | `BACKLOG_FIELD_CONDITION3_MG_AG` |
| 補足 | `BACKLOG_FIELD_CONDITION3_NOTE` |

## 海外IP契約（基本契約 / 変更合意）

| 用途 | Backlog属性名 | .env |
|---|---|---|
| 取引構造 | `deal_structure` | `BACKLOG_FIELD_DEAL_STRUCTURE` |
| 変更モード | `change_mode` | `BACKLOG_FIELD_CHANGE_MODE` |
| 元契約課題キー | `base_agreement_key` | `BACKLOG_FIELD_BASE_AGREEMENT_KEY` |
| 効力発生日 | `effective_date` | `BACKLOG_FIELD_EFFECTIVE_DATE` |
| 原著作物・IP名 | `original_work` | `BACKLOG_FIELD_ORIGINAL_WORK` |
| 許諾対象 / 権利範囲 | `license_scope` | `BACKLOG_FIELD_LICENSE_SCOPE` |
| 製品化対象 / 商品範囲 | `ip_product_scope` | `BACKLOG_FIELD_IP_PRODUCT_SCOPE` |
| 地域・言語 | `territory` | `BACKLOG_FIELD_TERRITORY` |
| 独占性 | `exclusivity` | `BACKLOG_FIELD_EXCLUSIVITY` |
| 収益モデル | `revenue_model` | `BACKLOG_FIELD_REVENUE_MODEL` |
| ロイヤリティ・対価条件 | `royalty_terms` | `BACKLOG_FIELD_ROYALTY_TERMS` |
| 再許諾可否 | `sublicense_allowed` | `BACKLOG_FIELD_SUBLICENSE_ALLOWED` |
| 権利帰属 / 成果物帰属 | `title_transfer_model` | `BACKLOG_FIELD_TITLE_TRANSFER_MODEL` |
| 終了後在庫処理 | `inventory_selloff` | `BACKLOG_FIELD_INVENTORY_SELLOFF` |
| 変更対象条項 | `amendment_clauses` | `BACKLOG_FIELD_AMENDMENT_CLAUSES` |
| 特記事項 | `special_notes` | `BACKLOG_FIELD_SPECIAL_NOTES` |

### Schedule 1

| 用途 | Backlog属性名 | .env |
|---|---|---|
| ロイヤルティ率 | `s1_royalty_rate` | `BACKLOG_FIELD_S1_ROYALTY_RATE` |
| MG | `s1_minimum_guarantee` | `BACKLOG_FIELD_S1_MINIMUM_GUARANTEE` |
| Advance | `s1_advance` | `BACKLOG_FIELD_S1_ADVANCE` |
| 会計期間 | `s1_accounting_period` | `BACKLOG_FIELD_S1_ACCOUNTING_PERIOD` |
| 支払期限 | `s1_payment_due` | `BACKLOG_FIELD_S1_PAYMENT_DUE` |
| レポート期限 | `s1_report_due` | `BACKLOG_FIELD_S1_REPORT_DUE` |
| 為替換算 | `s1_fx_conversion` | `BACKLOG_FIELD_S1_FX_CONVERSION` |
| 初回製造数量 | `s1_first_print_run` | `BACKLOG_FIELD_S1_FIRST_PRINT_RUN` |
| 発売目標日 | `s1_target_release_date` | `BACKLOG_FIELD_S1_TARGET_RELEASE_DATE` |
| 献本条件 | `s1_complimentary_copies` | `BACKLOG_FIELD_S1_COMPLIMENTARY_COPIES` |
| クレジット表記 | `s1_credit_wording` | `BACKLOG_FIELD_S1_CREDIT_WORDING` |
| 適用地域 / Jurisdiction | `s1_territory_jurisdiction` | `BACKLOG_FIELD_S1_TERRITORY_JURISDICTION` |
| Consumer Law Carve-Out | `s1_consumer_law_carveout` | `BACKLOG_FIELD_S1_CONSUMER_LAW_CARVEOUT` |
| VAT / GST | `s1_vat_gst_treatment` | `BACKLOG_FIELD_S1_VAT_GST_TREATMENT` |
| Copyright Registration | `s1_copyright_registration` | `BACKLOG_FIELD_S1_COPYRIGHT_REGISTRATION` |
| Moral Rights | `s1_moral_rights` | `BACKLOG_FIELD_S1_MORAL_RIGHTS` |
| Mandatory Distribution Law | `s1_mandatory_distribution_law` | `BACKLOG_FIELD_S1_MANDATORY_DISTRIBUTION_LAW` |
| Additional Terms | `s1_additional_terms` | `BACKLOG_FIELD_S1_ADDITIONAL_TERMS` |

### Schedule 2

| 用途 | Backlog属性名 | .env |
|---|---|---|
| 価格表 | `s2_product_price_list` | `BACKLOG_FIELD_S2_PRODUCT_PRICE_LIST` |
| MPR Year 1 | `s2_mpr_year1` | `BACKLOG_FIELD_S2_MPR_YEAR1` |
| MPR Year 2 | `s2_mpr_year2` | `BACKLOG_FIELD_S2_MPR_YEAR2` |
| MPR Year 3 onward | `s2_mpr_year3` | `BACKLOG_FIELD_S2_MPR_YEAR3` |
| Incoterms / Delivery | `s2_incoterms_delivery` | `BACKLOG_FIELD_S2_INCOTERMS_DELIVERY` |
| Arrival Point | `s2_arrival_point` | `BACKLOG_FIELD_S2_ARRIVAL_POINT` |
| 前払条件 | `s2_payment_advance` | `BACKLOG_FIELD_S2_PAYMENT_ADVANCE` |
| 残額支払条件 | `s2_payment_balance` | `BACKLOG_FIELD_S2_PAYMENT_BALANCE` |
| 支払通貨 | `s2_payment_currency` | `BACKLOG_FIELD_S2_PAYMENT_CURRENCY` |
| 適用地域 / Jurisdiction | `s2_territory_jurisdiction` | `BACKLOG_FIELD_S2_TERRITORY_JURISDICTION` |
| Import / Customs | `s2_import_customs_allocation` | `BACKLOG_FIELD_S2_IMPORT_CUSTOMS_ALLOCATION` |
| Consumer Product Safety | `s2_consumer_product_safety` | `BACKLOG_FIELD_S2_CONSUMER_PRODUCT_SAFETY` |
| Distribution Law Protections | `s2_distribution_law_protections` | `BACKLOG_FIELD_S2_DISTRIBUTION_LAW_PROTECTIONS` |
| VAT / GST on Supply | `s2_vat_gst_supply` | `BACKLOG_FIELD_S2_VAT_GST_SUPPLY` |
| Product Liability Insurance | `s2_product_liability_insurance` | `BACKLOG_FIELD_S2_PRODUCT_LIABILITY_INSURANCE` |
| Marketplace / Online Sales | `s2_marketplace_online_sales` | `BACKLOG_FIELD_S2_MARKETPLACE_ONLINE_SALES` |
| Additional Terms | `s2_additional_terms` | `BACKLOG_FIELD_S2_ADDITIONAL_TERMS` |

## 発注書・企画発注書・出版発注書

| 用途 | Backlog属性名 | .env |
|---|---|---|
| 発注日 | `order_date` | `BACKLOG_FIELD_ORDER_DATE` |
| 案件名 | `project_title` | `BACKLOG_FIELD_PROJECT_TITLE` |
| 基本契約参照番号 | `master_contract_ref` | `BACKLOG_FIELD_MASTER_CONTRACT_REF` |
| 振込先情報 | `bank_info` | `BACKLOG_FIELD_BANK_INFO` |
| 支払条件 | `payment_terms` | `BACKLOG_FIELD_PAYMENT_TERMS` |
| 備考 | `remarks` | `BACKLOG_FIELD_REMARKS` |
| 特約 | `special_notes` | `BACKLOG_FIELD_SPECIAL_NOTES` |

### 出版発注書の期日管理

| 用途 | Backlog属性名 | `.env` |
|---|---|---|
| 校了予定 / 最終締切 | `final_deadline` | `BACKLOG_FIELD_FINAL_DEADLINE` |
| 検収回答期限 | `accept_reply_due_date` | `BACKLOG_FIELD_ACCEPT_REPLY_DUE_DATE` |
| 検収日 | 専用属性を追加推奨 | `BACKLOG_FIELD_INSPECTION_DATE` |
| 支払予定日 | 専用属性を追加推奨 | `BACKLOG_FIELD_PAYMENT_PLANNED_DATE` |

補足:

- `出版発注書` は親課題
- `納品リクエスト` は 1明細1課題
- 明細ごとの `納期 / 検収日 / 支払予定日` は子課題で持つ

## 納品リクエスト

| 用途 | Backlog属性名 | `.env` |
|---|---|---|
| 親課題キー | `parent_issue_key` | `BACKLOG_FIELD_PARENT_ISSUE_KEY` |
| 明細番号 | `item_no` | `BACKLOG_FIELD_ITEM_NO` |
| 納品備考 | `delivery_note` | `BACKLOG_FIELD_DELIVERY_NOTE` |
| 今回納品金額 | `delivered_amount` | `BACKLOG_FIELD_DELIVERED_AMOUNT` |

## 利用許諾料計算の期限管理

| 用途 | Backlog属性名 | `.env` |
|---|---|---|
| 製造完了日 | `completion_date` | `BACKLOG_FIELD_COMPLETION_DATE` |
| 報告対象期間開始 | `report_period_start` | `BACKLOG_FIELD_REPORT_PERIOD_START` |
| 報告対象期間終了 | `report_period_end` | `BACKLOG_FIELD_REPORT_PERIOD_END` |
| 報告期限 | `s1_report_due` など | `BACKLOG_FIELD_S1_REPORT_DUE` |
| 支払期限 | `s1_payment_due` など | `BACKLOG_FIELD_S1_PAYMENT_DUE` |

## 注意事項

- `special_terms` は使わず `special_notes` に統一する
- `remarks` は文書備考なのか運用備考なのかを分けると運用しやすい
- JSON テンプレートの課題タイプ名と `.env` の課題タイプ名は一致させる
- 売買契約は `売買契約（当社買手）` `売買契約（当社売手・標準）` `売買契約（当社売手・保証金掛け売り）` の3課題タイプで運用する
- `業務委託基本契約` を正式課題タイプ名とし、旧 `業務委託契約` は互換扱いにする
- 納品系の正式課題タイプ名は `納品リクエスト` とし、旧 `納品報告` は互換扱いにする
- `個別利用許諾条件` は独立課題タイプとしても運用し、`ライセンス契約` とセット生成するケースも許容する
