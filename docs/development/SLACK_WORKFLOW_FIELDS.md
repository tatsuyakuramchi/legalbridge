# Slack Workflow Fields

## 目的

`/法務依頼` の Slack ワークフローで、どの文書種別に何を聞くかを固定する。

## 画面構成方針

1. `/法務依頼` を単一入口にする
2. 1画面目で `新規依頼` / `既存課題に追記` を選ぶ
3. 新規依頼は最小項目で受け付ける
4. 追記は課題キー・追記内容・添付だけを受け付ける
5. 送信後に Backlog 課題キーを返し、必要なら後続申請ショートカットを出す

## 新規依頼の最小項目

| 項目 | 必須 | 備考 |
|---|---|---|
| 依頼種別 | 必須 | `contract_type` |
| 件名 | 必須 | `summary` |
| 依頼内容 | 必須 | `notes` |
| 希望納期 | 任意 | `deadline` |
| 相手先名 | 任意 | `counterparty` |
| 添付ファイル | 任意 | `request_attachments` |

## 依頼種別

Slack の入口では、次の 10 種別に絞って表示する。

- レビュー依頼
- 法務相談
- 秘密保持契約（NDA）
- 業務委託基本契約
- ライセンス契約
- 海外IP契約
- 売買契約
- 発注書
- 企画発注書
- 出版発注書

補足:

- `レビュー依頼` は相手方ドラフトや見積書などのレビュー受付を意味する
- `法務相談` は契約化前の論点整理や進め方相談を意味する
- `海外IP契約` は入口ラベルであり、必要に応じて管理側で詳細種別へ寄せる
- `売買契約` は入口ラベルであり、必要に応じて管理側で買手 / 売手系へ寄せる
- Backlog の `契約種別` カスタム属性には入口ラベルを記録する

## 既存課題への追記項目

| 項目 | 必須 | 備考 |
|---|---|---|
| 課題キー | 必須 | `existing_issue_key` |
| 追記内容 | 添付がなければ必須 | `append_notes` |
| 添付ファイル | 追記がなければ任意不可 | `request_attachments` |

## 旧詳細モーダルの項目群

以下は将来の詳細入力や管理UI補完で使う前提で残している項目群。

以下は単票系の文書で共通に使う。  
ただし `法務相談` は相談受付を優先するため、登録番号・相手方・住所を任意で扱う。

| 項目 | 必須 | 備考 |
|---|---|---|
| 登録番号 | 条件付き | `registration_number` |
| 相手方名 | 条件付き | `counterparty` |
| 希望期限 | 任意 | `desired_due_date` |
| 備考 | 任意 | `remarks` |
| 補足・参考資料 | 任意 | `notes` |

## 文書種別ごとの設問

### 法務相談

| 項目 | 必須 | 備考 |
|---|---|---|
| 相手方・相談先 | 任意 | `counterparty` |
| 相談背景・補足 | 任意 | `remarks` |
| 相談内容・レビュー観点 | 任意 | `notes` |

他社文書レビュー依頼と法務相談を同じ入口で受ける。

### NDA

| 項目 | 必須 | 備考 |
|---|---|---|
| 契約日 | 必須 | `contract_date` |
| 秘密保持の目的 | 必須 | `nda_purpose` |
| 契約期間 | 必須 | `contract_period` |
| 秘密保持期間 | 任意 | `confidentiality_period` |

補足:

- `jurisdiction`

は Slack では受けず、Backlog / Local 側で補完する。

### 業務委託基本契約

| 項目 | 必須 | 備考 |
|---|---|---|
| 契約日 | 必須 | `contract_date` |
| 業務概要・前提情報 | 任意 | `notes` |

補足:

- `contract_period`
- `jurisdiction`

は Slack では受けず、Backlog / Local 側で補完する。

### ライセンス契約

| 項目 | 必須 | 備考 |
|---|---|---|
| 契約日 | 任意 | `contract_date` |
| 原著作物 | 必須 | `original_work` |
| 管轄裁判所 | 必須 | `jurisdiction` |

補足:

- `original_author`
- `credit_name`
- `succession_memorandum_date`
- `contract_period`

は Slack では受けず、Backlog / Local 側で補完する。

### 個別利用許諾条件

Slack ではヘッダだけ受け、詳細な金銭条件や素材情報は Backlog / Local 側で補完する。

| 項目 | 必須 | 備考 |
|---|---|---|
| 親ライセンス課題キー | 必須 | `license_issue_key` |
| 許諾区分 | 必須 | `license_type_name` |
| 対象作品・原著作物 | 必須 | `original_work` |
| 許諾開始日 | 必須 | `license_start` |
| 許諾地域・言語 | 任意 | `territory` |

補足:

- `calculation_method_label`
- `rate_label`
- `payment_terms_label`
- `mg_ag_label`
- `material_*`
- `money1_*`
- `money2_*`
- `money3_*`

は Slack モーダルでは受けず、起票後に Backlog / Local 側で補完する。

### 売買契約（当社買手）

| 項目 | 必須 | 備考 |
|---|---|---|
| 契約日 | 必須 | `contract_date` |
| 商品範囲 | 必須 | `product_scope` |
| 支払条件概要 | 必須 | `payment_condition_summary` |
| 補足メモ | 任意 | `notes` |

補足:

- `delivery_location`
- `inspection_period_days`
- `warranty_period`
- `jurisdiction`

は Slack では受けず、Backlog / Local 側で補完する。

### 売買契約（当社売手・標準）

| 項目 | 必須 | 備考 |
|---|---|---|
| 契約日 | 必須 | `contract_date` |
| 商品範囲 | 必須 | `product_scope` |
| 支払条件概要 | 必須 | `payment_condition_summary` |
| 補足メモ | 任意 | `notes` |

補足:

- `monthly_closing_day`
- `payment_due_day`
- `payment_method`
- `warranty_period`
- `jurisdiction`

は Slack では受けず、Backlog / Local 側で補完する。

### 売買契約（当社売手・保証金掛け売り）

| 項目 | 必須 | 備考 |
|---|---|---|
| 契約日 | 必須 | `contract_date` |
| 商品範囲 | 必須 | `product_scope` |
| 支払条件概要 | 必須 | `payment_condition_summary` |
| 保証金額 | 必須 | `security_deposit_amount` |
| 保証金補充期限 | 必須 | `deposit_replenish_days` |
| 補足メモ | 任意 | `notes` |

補足:

- `monthly_closing_day`
- `payment_due_day`
- `payment_method`
- `warranty_period`
- `jurisdiction`

は Slack では受けず、Backlog / Local 側で補完する。

### 発注書

Slack ではヘッダ中心に受け、明細は管理UIまたは CSV で補完する。

| 項目 | 必須 | 備考 |
|---|---|---|
| 案件名 | 必須 | `project_title` |
| 発注概要 | 任意 | `order_summary` |

### 企画発注書

Slack ではヘッダのみ受け、明細は XLSX / CSV 取込を前提にする。

| 項目 | 必須 | 備考 |
|---|---|---|
| 案件名 | 必須 | `project_title` |

### 出版発注書

Slack ではヘッダのみ受け、書誌進行・制作進行の明細は CSV 取込を前提にする。

| 項目 | 必須 | 備考 |
|---|---|---|
| 案件名 | 必須 | `project_title` |
| マスター契約参照 | 任意 | `master_contract_ref` |
| 進行概要 | 任意 | `order_summary` |

補足:

- `初校締切 / 再校締切 / 校了予定 / 検収日 / 支払予定日` は、CSV と Backlog 子課題で管理する
- Slack 入口では出版進行のヘッダだけを受ける

### 納品リクエスト

| 項目 | 必須 | 備考 |
|---|---|---|
| 親課題キー | 必須 | `parent_issue_key` |
| 明細番号 | 必須 | `item_no` |
| 納品備考 | 任意 | `delivery_note` |

### 利用許諾料計算（製造ベース）

| 項目 | 必須 | 備考 |
|---|---|---|
| 紐付けライセンス課題キー | 必須 | `license_issue_key` |
| 製品名 | 必須 | `product_name` |
| 製造完了日 | 必須 | `completion_date` |
| 製造数量 | 必須 | `quantity` |
| MSRP | 必須 | `msrp` |
| 備考 | 任意 | `remarks` |

### 利用許諾料計算（売上報告ベース）

| 項目 | 必須 | 備考 |
|---|---|---|
| 紐付けライセンス課題キー | 必須 | `license_issue_key` |
| 製品名 | 必須 | `product_name` |
| 報告対象期間終了 | 必須 | `report_period_end` |
| 売上高 | 必須 | `sales_amount` |
| 備考 | 任意 | `remarks` |

補足:

- 製造ベースでは `completion_date` を起点に `報告期限 / 支払期限` を Backlog で管理する
- 売上報告ベースでは `report_period_end` を起点に `報告期限 / 支払期限` を Backlog で管理する

## 送信後のアクション

- 法務相談:
  - 後続ショートカットなし
- 発注書 / 企画発注書:
  - `納品リクエストを作成`
- ライセンス契約 / 個別利用許諾条件:
  - `利用許諾料計算を作成`

## 開発時のルール

- 先に `NDA` と `業務委託基本契約` を完成形にする
- 次に `ライセンス契約` と `個別利用許諾条件` を多段モーダル化する
- 売買契約3種は共通項目を使いながら差分だけ持つ
- 発注書系は Slack に明細を持たせすぎない

## 通知ルーティング補足

- 受付親投稿は申請者の Staff マスタの `department` を起点に通知先を解決する
- 部署別設定では `投稿チャンネル / 上長ID / 承認（押印）ID / 実行（押印）ID` を持つ
- 部署別設定がない場合のみ、ワークフロー設定の既定値へフォールバックする
- 部署候補は Staff テーブルに登録済みの部署名を管理UIで候補表示する
- 受付完了、検収書生成、利用許諾料計算書生成、納期アラート、承認完了、差戻し、押印系のアンサーバックは指定チャンネル側へ集約する
- アンサーバック本文の先頭には原則として `申請者` と `上長ID` をメンションする
