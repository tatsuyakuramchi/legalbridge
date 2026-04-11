# Publishing Order Backlog Design

## 目的

出版発注書を `Slack -> Backlog` の受付主線に乗せつつ、`CSV一括取込 -> 1明細1課題 -> 納品リクエスト -> 検収書` までを Backlog 正本で管理できる形にする。

## 基本方針

- 親課題は `出版発注書`
- 子課題は `明細ごとの納品管理課題`
- 1CSV の 1明細につき 1課題を作る
- `納期 / 検収日 / 支払予定日` は Backlog を正本にする
- Local / DB は CSV明細、帳票生成、生成履歴の補助に徹する

## 課題構造

### 親課題: 出版発注書

用途:

- 発注全体のヘッダ
- 案件名
- 相手方
- 発注日
- マスター契約参照
- 進行概要

保持する値:

| 用途 | 推奨 Backlog 属性 | `.env` |
|---|---|---|
| 発注日 | `order_date` | `BACKLOG_FIELD_ORDER_DATE` |
| 案件名 | `project_title` | `BACKLOG_FIELD_PROJECT_TITLE` |
| マスター契約参照 | `master_contract_ref` | `BACKLOG_FIELD_MASTER_CONTRACT_REF` |
| 進行概要 | `remarks` または `payment_condition_summary` | `BACKLOG_FIELD_REMARKS` など |
| 相手方 | `counterparty` | `BACKLOG_FIELD_COUNTERPARTY` |

### 子課題: 出版明細管理課題

現行運用では `納品リクエスト` を明細単位課題として使う。

保持する値:

| 用途 | 推奨 Backlog 属性 | `.env` |
|---|---|---|
| 親課題キー | `parent_issue_key` | `BACKLOG_FIELD_PARENT_ISSUE_KEY` |
| 明細番号 | `item_no` | `BACKLOG_FIELD_ITEM_NO` |
| 成果物名 | `item_name` | `BACKLOG_FIELD_ITEM_NAME` |
| 業務概要 | `remarks` または `delivery_note` | `BACKLOG_FIELD_DELIVERY_NOTE` |
| 今回納品金額 | `delivered_amount` | `BACKLOG_FIELD_DELIVERED_AMOUNT` |
| 納期 | `期限日` または `final_deadline` | `BACKLOG_FIELD_FINAL_DEADLINE` |
| 検収日 | 専用日付属性を推奨 | `BACKLOG_FIELD_INSPECTION_DATE` を将来追加候補 |
| 支払予定日 | 専用日付属性を推奨 | `BACKLOG_FIELD_PAYMENT_PLANNED_DATE` を将来追加候補 |

## CSV と Backlog の関係

同一フォーマットの CSV を使う。

- 発注書一括作成時:
  - `検収日` は空欄でもよい
  - `納期` は必須
- 検収書一括作成時:
  - 同じ CSV に `検収日` を入れて再アップロードする

推奨列:

| CSV列 | 用途 | 正本 |
|---|---|---|
| `コード` | 取引先識別 | DB / Vendor |
| `支払先（本名）` | 正式名称 | DB / Vendor |
| `支払先（ペンネーム）` | 別名・照合名 | DB / Vendor |
| `業務名` | 明細名 | DB / Backlog |
| `業務概要` | 仕様・備考 | DB / Backlog |
| `業務総額（税込）` | 金額 | DB / Backlog |
| `数量` | 数量 | DB |
| `納期` | 納期 | Backlog |
| `発注日` | 親課題ヘッダ | Backlog |
| `検収日` | 検収書基準日 | Backlog |
| `支払予定日` | 支払予定管理 | Backlog |

## 一括起票ルール

### 発注書一括作成

1. 親課題 `出版発注書` を 1 件作る
2. CSV 明細を DB に取込む
3. 明細ごとに `納品リクエスト` を 1 件ずつ起票する
4. 子課題には `親課題キー / 明細番号 / 納期 / 金額` を入れる

### 検収書一括作成

1. 同じ CSV に `検収日` を入れる
2. 明細ごとに対象 `納品リクエスト` を特定する
3. 検収書を生成する
4. Backlog 課題を `処理済み` に更新する
5. 失敗した課題は `要確認` として結果一覧に残す

## 期日正本ルール

### 出版発注書

- 親課題:
  - 発注日
  - 全体進行の概要
- 子課題:
  - 納期
  - 検収日
  - 支払予定日

### 利用許諾料計算

- 製造ベース:
  - `completion_date` を起点に `報告期限 / 支払期限` を Backlog に同期
- 売上報告ベース:
  - `report_period_end` を起点に `報告期限 / 支払期限` を Backlog に同期

## 状態遷移

### 納品リクエスト

- 起票直後: `未対応` または初期状態
- 納品受付後: `処理中`
- 検収書生成後: `処理済み`

### 整合性ルール

- Local DB では `DeliveryEvent.status = PASSED`
- Backlog では `処理済み`
- Backlog 更新に失敗した場合:
  - バッチ全体は止めない
  - 課題を `要確認` として返す
  - コメントに同期失敗を残す

## 今後の推奨追加属性

出版運用を Backlog だけで見やすくするなら、次の属性追加が有効。

| 用途 | 推奨 `.env` |
|---|---|
| 検収日 | `BACKLOG_FIELD_INSPECTION_DATE` |
| 支払予定日 | `BACKLOG_FIELD_PAYMENT_PLANNED_DATE` |
| 初校締切 | `BACKLOG_FIELD_FIRST_PROOF_DEADLINE` |
| 再校締切 | `BACKLOG_FIELD_SECOND_PROOF_DEADLINE` |
| 校了予定 | `BACKLOG_FIELD_FINAL_DEADLINE` |

## ローカル側の役割

- CSV 読込
- Vendor / Staff 補完
- 発注書、検収書、支払通知書の生成
- 生成済み文書 URL の保存
- Backlog 課題へのコメント追記

ただし、運用上の期日と状態は Backlog を基準に見る。
