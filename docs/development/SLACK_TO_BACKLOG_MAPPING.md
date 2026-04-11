# Slack To Backlog Mapping

## 現在の方針

現在は `Slack -> Backlog` を受付主線にし、`Local UI / DB` は文書生成と補助処理に分離している。

Cloud Run 受付ではこの方針をさらに強め、`まず Backlog に課題を作る` ことを最優先にする。

- Backlog 起票は必須
- Slack 法務チャンネル通知は任意
- `LegalRequest` の DB 保存は任意
- 契約番号採番は任意

そのため Cloud Run 側では `DATABASE_URL` や `SLACK_LEGAL_CHANNEL` が未設定でも、Backlog 起票までは成立する。

- Backlog
  - 課題キー
  - 期限
  - 状態
  - 後続課題の起点
- UI / DB
  - 文書生成
  - 明細
  - 補助マスタ
  - 生成履歴

この表は `Slack入力のうち Backlog に残す最小項目` を中心に整理する。

## 目的

Slack モーダルの入力値を、Backlog カスタム属性、DB 補完、テンプレート変数へどう流すかを固定する。

## 変換ルール

- Slack の入力値をそのまま Backlog へ入れるもの
- Backlog へは入れず DB 補完するもの
- Backlog と DB を組み合わせてテンプレートへ渡すもの

## 共通項目

| Slack blockId | Backlog属性 | `.env` | DB補完 | 主な用途 |
|---|---|---|---|---|
| `counterparty` | `counterparty` | `BACKLOG_FIELD_COUNTERPARTY` | Vendor候補照合 | 相手方名 |
| `desired_due_date` | `deadline` | `BACKLOG_FIELD_DEADLINE` | なし | 希望期限 |
| `counterparty_address` | `counterparty_address` | `BACKLOG_FIELD_COUNTERPARTY_ADDRESS` | Vendor住所で補完可 | 相手方住所 |
| `counterparty_representative` | `counterparty_rep` | `BACKLOG_FIELD_COUNTERPARTY_REP` | Vendor代表者で補完可 | 相手方代表者 |
| `remarks` | `remarks` | `BACKLOG_FIELD_REMARKS` | なし | 備考 |
| `notes` | `remarks` | `BACKLOG_FIELD_REMARKS` | なし | 補足・参考資料 |

## 共通方針

- `概要`, `相手方`, `契約日`, `参照キー` は Backlog に残す
- `口座情報`, `自社情報`, `帳票表示の確定値` は UI / DB に寄せる
- `素材情報`, `金銭条件`, `細かな許諾条件` は UI / DB に寄せる
- `発注書系の明細` は Slack からは送らず、CSV / Local UI で補完する
- `納期`, `検収日`, `報告期限`, `支払期限` は Backlog を正本にする

## 対象課題種別

- NDA
- 業務委託基本契約
- ライセンス契約
- 個別利用許諾条件
- 海外IP契約
- 売買契約
- 発注書
- 企画発注書
- 出版発注書
- 納品リクエスト
- 利用許諾料計算

## NDA

| Slack blockId | Backlog属性 | `.env` | 主な用途 |
|---|---|---|---|
| `contract_date` | `contract_date` | `BACKLOG_FIELD_CONTRACT_DATE` | 契約日 |
| `contract_period` | `contract_period` | `BACKLOG_FIELD_CONTRACT_PERIOD` | 契約期間 |
| `confidentiality_period` | `confidentiality_period` | `BACKLOG_FIELD_CONFIDENTIALITY_PERIOD` | 秘密保持期間 |
| `nda_purpose` | `nda_purpose` | `BACKLOG_FIELD_NDA_PURPOSE` | 目的 |
| `jurisdiction` | `jurisdiction` | `BACKLOG_FIELD_JURISDICTION` | 管轄裁判所 |

NDA は比較的単票なので、主要条件は Backlog に残す。

## 法務相談

| Slack blockId | Backlog属性 | `.env` | 主な用途 |
|---|---|---|---|
| `counterparty` | `counterparty` | `BACKLOG_FIELD_COUNTERPARTY` | 相手方・相談先 |
| `desired_due_date` | `deadline` | `BACKLOG_FIELD_DEADLINE` | 希望期限 |
| `counterparty_address` | `counterparty_address` | `BACKLOG_FIELD_COUNTERPARTY_ADDRESS` | 相手方所在地 |
| `counterparty_representative` | `counterparty_rep` | `BACKLOG_FIELD_COUNTERPARTY_REP` | 相手方担当・代表者 |
| `remarks` | `remarks` | `BACKLOG_FIELD_REMARKS` | 相談背景・補足 |
| `notes` | `remarks` | `BACKLOG_FIELD_REMARKS` | 相談内容・レビュー観点 |

法務相談は文書生成前提ではなく、レビュー依頼と相談受付を優先する。未確定項目は空欄でも起票できる。

## 業務委託基本契約

| Slack blockId | Backlog属性 | `.env` | 主な用途 |
|---|---|---|---|
| `contract_date` | `contract_date` | `BACKLOG_FIELD_CONTRACT_DATE` | 契約日 |
| `contract_period` | `contract_period` | `BACKLOG_FIELD_CONTRACT_PERIOD` | 契約期間 |
| `jurisdiction` | `jurisdiction` | `BACKLOG_FIELD_JURISDICTION` | 管轄裁判所 |
| `remarks` | `remarks` | `BACKLOG_FIELD_REMARKS` | 備考 |
| `notes` | `remarks` | `BACKLOG_FIELD_REMARKS` | 業務概要・前提情報 |

口座情報、自社情報、帳票表示の確定値は UI / DB 側で扱う。

## ライセンス契約

| Slack blockId | Backlog属性 | `.env` | 主な用途 |
|---|---|---|---|
| `contract_date` | `contract_date` | `BACKLOG_FIELD_CONTRACT_DATE` | 契約日 |
| `original_work` | `original_work` | `BACKLOG_FIELD_ORIGINAL_WORK` | 原著作物 |
| `original_author` | `original_author` | `BACKLOG_FIELD_ORIGINAL_AUTHOR` | 原著作者 |
| `credit_name` | `credit_name` | `BACKLOG_FIELD_CREDIT_NAME` | クレジット表記 |
| `jurisdiction` | `jurisdiction` | `BACKLOG_FIELD_JURISDICTION` | 管轄裁判所 |

ライセンス基本契約は `業務委託基本契約に近い基本契約ヘッダ` として扱う。個別条件は別課題へ分離する。

## 個別利用許諾条件

### 基本項目

| Slack blockId | Backlog属性 | `.env` | 主な用途 |
|---|---|---|---|
| `license_issue_key` | `license_key` | `BACKLOG_FIELD_LICENSE_KEY` | 親ライセンス課題キー |
| `license_type_name` | `license_type_name` | `BACKLOG_FIELD_LICENSE_TYPE_NAME` | 種別名 |
| `original_work` | `original_work` | `BACKLOG_FIELD_ORIGINAL_WORK` | 原著作物 |
| `license_start` | `license_start` | `BACKLOG_FIELD_LICENSE_START` | 許諾開始日 |

個別利用許諾条件は `親ライセンス課題キー + ヘッダ` を Slack 初回起票の主線にし、詳細な条件は起票後に Backlog / UI / DB 側で補完する。

- 地域・言語の詳細表現
- 素材情報
- 金銭条件 1 / 2 / 3
- MG / AG 表示
- 計算方式の詳細

## 納品リクエスト

| Slack blockId | Backlog属性 | `.env` | DB補完 | 主な用途 |
|---|---|---|---|---|
| `parent_issue_key` | `parent_issue_key` | `BACKLOG_FIELD_PARENT_ISSUE_KEY` | 親案件照合 | 親課題キー |
| `item_no` | `item_no` | `BACKLOG_FIELD_ITEM_NO` | 明細照合 | 明細番号 |
| `delivery_note` | `delivery_note` | `BACKLOG_FIELD_DELIVERY_NOTE` | DeliveryEventへ転記 | 納品備考 |
| `delivered_amount` | `delivered_amount` | `BACKLOG_FIELD_DELIVERED_AMOUNT` | DeliveryEventへ転記 | 今回納品金額 |

明細、検収条件の詳細、支払通知書表示値は DB / UI 側で扱う。

補足:

- `/法務検索` の検索結果から起票する場合、Cloud Run 側では親課題キーを Backlog ベースで引き継ぐ
- 明細候補をローカル DB から取得できない場合は `item_no` の手入力にフォールバックする

## 売買契約3種

売買契約3種は、要約入力ではなく主要条件を個別フィールドで受ける構成にしています。テンプレート生成では Backlog の個別属性を優先し、未入力のものだけ既定値で補完します。

| Slack blockId | Backlog属性 | `.env` | 主な用途 |
|---|---|---|---|
| `contract_date` | `contract_date` | `BACKLOG_FIELD_CONTRACT_DATE` | 契約日 |
| `product_scope` | `product_scope` | `BACKLOG_FIELD_PRODUCT_SCOPE` | 商品範囲 |
| `delivery_location` | `delivery_location` | `BACKLOG_FIELD_DELIVERY_LOCATION` | 納入場所 |
| `inspection_period_days` | `inspection_period_days` | `BACKLOG_FIELD_INSPECTION_PERIOD_DAYS` | 検収期間 |
| `payment_condition_summary` | `payment_condition_summary` | `BACKLOG_FIELD_PAYMENT_CONDITION_SUMMARY` | 支払条件概要 |
| `warranty_period` | `warranty_period` | `BACKLOG_FIELD_WARRANTY_PERIOD` | 保証期間 |
| `monthly_closing_day` | `monthly_closing_day` | `BACKLOG_FIELD_MONTHLY_CLOSING_DAY` | 月末締め日 |
| `payment_due_day` | `payment_due_day` | `BACKLOG_FIELD_PAYMENT_DUE_DAY` | 支払期日 |
| `payment_method` | `payment_method` | `BACKLOG_FIELD_PAYMENT_METHOD` | 支払方法 |
| `security_deposit_amount` | `security_deposit_amount` | `BACKLOG_FIELD_SECURITY_DEPOSIT_AMOUNT` | 保証金額 |
| `deposit_replenish_days` | `deposit_replenish_days` | `BACKLOG_FIELD_DEPOSIT_REPLENISH_DAYS` | 保証金補充期限 |
| `notes` | `remarks` | `BACKLOG_FIELD_REMARKS` | 補足メモ |
| `jurisdiction` | `jurisdiction` | `BACKLOG_FIELD_JURISDICTION` | 管轄裁判所 |

売買契約は主要条件だけを Backlog に残し、帳票表示の微調整は UI 側で行う。

## 利用許諾料計算

| Slack blockId | Backlog属性 | `.env` | DB補完 | 主な用途 |
|---|---|---|---|---|
| `license_issue_key` | `license_key` | `BACKLOG_FIELD_LICENSE_KEY` | ライセンス案件照合 | 紐付け課題キー |
| `product_name` | `product_name` | `BACKLOG_FIELD_PRODUCT_NAME` | なし | 製品名 |
| `edition` | `edition` | `BACKLOG_FIELD_EDITION` | なし | 版 |
| `completion_date` | `completion_date` | `BACKLOG_FIELD_COMPLETION_DATE` | なし | 製造完了日 |
| `quantity` | `quantity` | `BACKLOG_FIELD_QUANTITY` | 計算基礎値 | 製造数量 |
| `msrp` | `msrp` | `BACKLOG_FIELD_MSRP` | 計算基礎値 | MSRP |
| `sample_quantity` | `sample_quantity` | `BACKLOG_FIELD_SAMPLE_QUANTITY` | 計算基礎値 | サンプル数 |
| `remarks` | `remarks` | `BACKLOG_FIELD_REMARKS` | なし | 備考 |

追加の Backlog 期日制御:

- 製造ベース:
  - `completion_date` を起点に `報告期限` と `支払期限` を Backlog に同期する
- 売上報告ベース:
  - `report_period_end` を起点に `報告期限` と `支払期限` を Backlog に同期する

計算結果、支払通知書表示値、振込先の確定値は DB 側を正本にする。

補足:

- `/法務検索` からの後続起票では、親ライセンス案件の検索は Backlog を正本にする
- Drive フォルダは DB 参照がなくても既定値で起票できる

## 発注書・企画発注書・出版発注書

Slack ではヘッダのみを入力し、Vendor、Staff、明細、金額詳細は DB と管理UIで補完する。

| Slack blockId | Backlog属性 | `.env` | DB補完 | 主な用途 |
|---|---|---|---|---|
| `contract_date` | `order_date` | `BACKLOG_FIELD_ORDER_DATE` | なし | 発注日 |
| `project_title` | `project_title` | `BACKLOG_FIELD_PROJECT_TITLE` | なし | 案件名 |
| `master_contract_ref` | `master_contract_ref` | `BACKLOG_FIELD_MASTER_CONTRACT_REF` | Vendorマスタで補完可 | 基本契約参照 |
| `payment_condition_summary` | `payment_condition_summary` | `BACKLOG_FIELD_PAYMENT_CONDITION_SUMMARY` | なし | 支払条件 |
| `special_notes` | `special_notes` | `BACKLOG_FIELD_SPECIAL_NOTES` | なし | 特記事項 |
| `remarks` | `remarks` | `BACKLOG_FIELD_REMARKS` | なし | 備考 |

出版発注書では追加で次の考え方を取る。

- Slack では `案件名 / 発注日 / マスター契約参照 / 進行概要` のみ持つ
- `初校締切 / 再校締切 / 校了予定 / 検収日 / 支払予定日` は CSV と Backlog 子課題で管理する
- 一括起票時は `1明細1課題` で Backlog を作成する

発注明細、金額詳細、Vendor 口座情報、Staff 情報は管理 UI / DB 側で扱う。

納期制御の方針:

- 親課題:
  - 発注ヘッダ
- 子課題:
  - 明細ごとの納期
  - 検収日
  - 支払予定日
- Local 側は Backlog 課題キーを起点に動作し、期日自体は Backlog を正本にする

## DB 補完ルール

- `Vendor`:
  - 相手方住所
  - 相手方代表者
  - 銀行情報
  - 基本契約参照番号
- `Staff`:
  - 申請者情報
  - 部署情報
- `DepartmentWorkflowRule`:
  - 承認者
  - 押印担当者
- `OrderItem`:
  - 発注明細
- `DeliveryEvent`:
  - 納品管理
- `ManufacturingEvent`:
  - 利用許諾料計算の基礎データ

## 期日正本ルール

| 業務 | Backlog 正本 | Local / DB の役割 |
|---|---|---|
| 発注書 | `期限日` または明細子課題の納期 | 帳票生成、CSV取込、明細保持 |
| 企画発注書 | `期限日` または明細子課題の納期 | 帳票生成、CSV取込、明細保持 |
| 出版発注書 | `校了予定 / 検収日 / 支払予定日` を課題で管理 | CSV取込、検収書生成、支払通知書生成 |
| 納品リクエスト | `納品日 / 検収日 / 状態` | DeliveryEvent と帳票生成 |
| 利用許諾料計算 | `報告期限 / 支払期限` | 計算実行、通知書生成、補助保存 |

## 実装ルール

- Slack の入力値は可能な限り `blockId` と `.env` 名を揃える
- Backlog に持たせにくい繰り返し明細は DB 主体にする
- `special_terms` は使わず `special_notes` に統一する
- 課題キーは後続申請の主キーとして Slack DM で必ず返す
- `/法務検索` はローカル DB 検索ではなく Backlog 検索を正とする
