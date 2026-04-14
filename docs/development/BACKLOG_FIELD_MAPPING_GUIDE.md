# Backlog Field Mapping Guide

更新日: 2026-04-14

## 目的

現行の LegalBridge では、Backlog は `ステータス管理 + 任意の補足欄` として使う。  
本資料は、Backlog に残している属性と `BACKLOG_FIELD_*` の対応を示す。

## 前提

- Backlog 上のカスタム属性は **すべて任意**
- 未設定の属性はアプリ側でスキップする
- 詳細条件や帳票向け情報は DB / 管理 UI 側で保持する

## 共通補足

| Backlog属性名 | env |
|---|---|
| 相手方 | `BACKLOG_FIELD_COUNTERPARTY` |
| 希望期限 | `BACKLOG_FIELD_DEADLINE` |
| 備考 | `BACKLOG_FIELD_REMARKS` |
| 文書番号 | `BACKLOG_FIELD_CONTRACT_NO` |

## 契約系 / 発注系ヘッダ

| Backlog属性名 | env | 主な対象 |
|---|---|---|
| 契約日・発注日 | `BACKLOG_FIELD_CONTRACT_DATE` | NDA / 業務委託 / ライセンス / 海外IP / 発注書系 |
| 契約期間 | `BACKLOG_FIELD_CONTRACT_PERIOD` | 契約系 |
| 案件名 | `BACKLOG_FIELD_PROJECT_TITLE` | 発注書 / 企画発注書 / 出版発注書 |

## 個別利用許諾条件 / 後続課題

| Backlog属性名 | env |
|---|---|
| 親ライセンス課題キー | `BACKLOG_FIELD_LICENSE_KEY` |
| 許諾開始日 | `BACKLOG_FIELD_LICENSE_START` |
| 親課題キー | `BACKLOG_FIELD_PARENT_ISSUE_KEY` |
| 明細番号 | `BACKLOG_FIELD_ITEM_NO` |

## 納品リクエスト

| Backlog属性名 | env |
|---|---|
| 納品備考 | `BACKLOG_FIELD_DELIVERY_NOTE` |
| 今回納品金額 | `BACKLOG_FIELD_DELIVERED_AMOUNT` |
| 納期 / 校了予定 | `BACKLOG_FIELD_FINAL_DEADLINE` |
| 検収日 | `BACKLOG_FIELD_INSPECTION_DATE` |
| 支払予定日 | `BACKLOG_FIELD_PAYMENT_PLANNED_DATE` |

## 利用許諾料計算

| Backlog属性名 | env |
|---|---|
| 製品名 / 対象商品名 | `BACKLOG_FIELD_PRODUCT_NAME` |
| 版 | `BACKLOG_FIELD_EDITION` |
| 製造完了日 | `BACKLOG_FIELD_COMPLETION_DATE` |
| 数量 | `BACKLOG_FIELD_QUANTITY` |
| MSRP | `BACKLOG_FIELD_MSRP` |
| サンプル数量 | `BACKLOG_FIELD_SAMPLE_QUANTITY` |
| 報告対象期間開始 | `BACKLOG_FIELD_REPORT_PERIOD_START` |
| 報告対象期間終了 | `BACKLOG_FIELD_REPORT_PERIOD_END` |
| 売上高・正味売上高 | `BACKLOG_FIELD_NET_SALES` |
| 報告期限 | `BACKLOG_FIELD_S1_REPORT_DUE` |
| 支払期限 | `BACKLOG_FIELD_S1_PAYMENT_DUE` |

## Backlog に残さない項目

次のような項目は現在の正式マッピング対象外である。

- 相手方住所 / 相手方代表者
- NDA 目的 / 秘密保持期間 / 管轄裁判所
- 原著作物 / 原著作者 / クレジット表記
- 素材情報群
- `CONDITION1_*` `CONDITION2_*` `CONDITION3_*`
- 発注書・売買契約の詳細支払条件
- 海外IPの詳細条件群

これらは DB / 管理 UI / 文書生成ロジック側で保持する。

## 関連資料

- [Backlog Setup Checklist](C:/Users/tatsuya.kuramochi/Desktop/legalbrigde-proto_GCP/docs/operations/BACKLOG_SETUP_CHECKLIST.md)
- [Backlog Field Reduction Candidates](C:/Users/tatsuya.kuramochi/Desktop/legalbrigde-proto_GCP/docs/operations/BACKLOG_FIELD_REDUCTION_CANDIDATES.md)
