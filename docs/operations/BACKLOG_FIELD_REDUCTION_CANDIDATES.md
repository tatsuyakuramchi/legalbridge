# Backlog カスタム属性整理一覧

更新日: 2026-04-14

## 目的

Backlog を `ステータス管理` と `課題の最小補足情報` に絞るため、現行の Backlog カスタム属性を次の 3 区分で整理する。

- `残す`
  - Backlog に残すべき最小項目
- `DBへ移す`
  - Slack または管理 UI で受け、DB / アプリ内部で保持すれば十分な項目
- `削除候補`
  - 現行の運用では重く、Backlog で持つ意義が薄い項目

本資料は当初の整理検討資料として作成したが、2026-04-14 時点で第1段階の整理は実施済みである。

## 2026-04-14 時点の整理方針

現時点での決定事項は次の通り。

- 契約系
  - `契約日` と `契約期間` 以外は DB へ移す
- 発注書系
  - `発注日` と `案件名` 以外は DB へ移す
- 納品リクエスト
  - 現状維持
- 利用許諾料計算
  - 現状維持
- 個別利用許諾条件
  - `許諾開始日` と `親ライセンス課題キー` 以外は DB へ移す

つまり、Backlog はできる限り「進行と最小ヘッダ」のみに絞り、詳細条件や帳票向け情報は DB / 管理 UI 側へ寄せる。

## 2026-04-14 時点の実施結果

第1段階として、次を反映済みである。

- 不要な旧カスタム属性を削除
- 残す属性を日本語ラベルへ統一
- 残す属性もすべて任意化
- 海外IP課題タイプ
  - `海外IP契約（基本契約）`
  - `海外IP契約（変更合意）`
  を追加

現在 Backlog に残している属性は次の最小セットである。

- `相手方`
- `希望期限`
- `備考`
- `文書番号`
- `契約日・発注日`
- `契約期間`
- `案件名`
- `親ライセンス課題キー`
- `許諾開始日`
- `親課題キー`
- `明細番号`
- `納品備考`
- `今回納品金額`
- `納期 / 校了予定`
- `検収日`
- `支払予定日`
- `製品名 / 対象商品名`
- `版`
- `製造完了日`
- `数量`
- `MSRP`
- `サンプル数量`
- `報告対象期間開始`
- `報告対象期間終了`
- `売上高・正味売上高`
- `報告期限`
- `支払期限`

## 判断基準

### 残す

- Backlog 一覧や検索で見える価値が高い
- ステータス進行や後続課題の起点になる
- Slack モーダルの最小入力と整合する

### DBへ移す

- 文書生成には必要だが、Backlog 上で日常的に確認しない
- Staff / Vendor / 明細 / CSV 取込で補完できる
- 帳票や内部ロジック向けの補助値である

### 削除候補

- 表示専用
- 条件が細かすぎて Slack モーダルにも Backlog にも不向き
- 実運用で使わない、または DB 側で持てば十分

## 全体方針

### Backlog に残す情報

- 件名
- ステータス
- 期限
- 相手先などのヘッダ
- 親課題キー、参照課題キー
- 最小限の契約・発注ヘッダ

### Backlog から外したい情報

- 帳票表示専用項目
- 明細由来の詳細値
- 条件セット 1 / 2 / 3 のような複雑な繰り返し情報
- 素材情報群
- 金銭条件の表現用ラベル

## 共通ヘッダ項目

| 項目 | 現行 `.env` | 推奨区分 | 理由 |
|---|---|---|---|
| 相手方 | `BACKLOG_FIELD_COUNTERPARTY` | 残す | 課題一覧・検索で有効 |
| 希望期限 | `BACKLOG_FIELD_DEADLINE` | 残す | ステータス運用の基礎 |
| 登録番号 | `BACKLOG_FIELD_CONTRACT_NO` | 条件付きで残す | 契約系では識別に有効 |
| 備考 | `BACKLOG_FIELD_REMARKS` | 残す | 最小補足として有効 |
| 相手方住所 | `BACKLOG_FIELD_COUNTERPARTY_ADDRESS` | DBへ移す | Vendor 補完しやすい |
| 相手方代表者 | `BACKLOG_FIELD_COUNTERPARTY_REP` | DBへ移す | Vendor 補完しやすい |
| 特記事項 | `BACKLOG_FIELD_SPECIAL_NOTES` | DBへ移す | 帳票寄りで日常確認頻度が低い |

## 契約系

### 確定方針

- Backlog に残す
  - `契約日`
  - `契約期間`
- DB へ移す
  - 上記以外すべて

### 残す候補

| 項目 | `.env` | 理由 |
|---|---|---|
| 契約日 | `BACKLOG_FIELD_CONTRACT_DATE` | 契約ヘッダの最小要素 |
| 契約期間 | `BACKLOG_FIELD_CONTRACT_PERIOD` | NDA / 基本契約で有効 |
| 秘密保持期間 | `BACKLOG_FIELD_CONFIDENTIALITY_PERIOD` | 今後は DB へ移す前提。移行完了までの暫定候補 |
| NDA 目的 | `BACKLOG_FIELD_NDA_PURPOSE` | 今後は DB へ移す前提。移行完了までの暫定候補 |
| 管轄裁判所 | `BACKLOG_FIELD_JURISDICTION` | 今後は DB へ移す前提。移行完了までの暫定候補 |
| 原著作物 | `BACKLOG_FIELD_ORIGINAL_WORK` | 今後は DB へ移す前提。移行完了までの暫定候補 |

### DBへ移す候補

| 項目 | `.env` | 理由 |
|---|---|---|
| 原著作者 | `BACKLOG_FIELD_ORIGINAL_AUTHOR` | 文書生成寄り |
| クレジット表記 | `BACKLOG_FIELD_CREDIT_NAME` | 帳票寄り |
| 承継覚書日付 | `BACKLOG_FIELD_SUCCESSION_MEMORANDUM_DATE` | 例外的で日常確認頻度が低い |

## 発注書系

### 確定方針

- Backlog に残す
  - `発注日`
  - `案件名`
- DB へ移す
  - 上記以外すべて

### 残す候補

| 項目 | `.env` | 理由 |
|---|---|---|
| 発注日 | `BACKLOG_FIELD_ORDER_DATE` | 親課題ヘッダとして有効 |
| 案件名 | `BACKLOG_FIELD_PROJECT_TITLE` | 一覧性が高い |
| 基本契約参照番号 | `BACKLOG_FIELD_MASTER_CONTRACT_REF` | 今後は DB へ移す前提。移行完了までの暫定候補 |
| 承諾回答期限 | `BACKLOG_FIELD_ACCEPT_REPLY_DUE_DATE` | 今後は DB へ移す前提。移行完了までの暫定候補 |
| 最終締切 | `BACKLOG_FIELD_FINAL_DEADLINE` | 今後は DB へ移す前提。移行完了までの暫定候補 |

### DBへ移す候補

| 項目 | `.env` | 理由 |
|---|---|---|
| 支払条件 | `BACKLOG_FIELD_PAYMENT_TERMS` | 帳票・表示寄り |
| 銀行情報 | `BACKLOG_FIELD_BANK_INFO` | 機微情報で DB 管理向き |
| 検収日 | `BACKLOG_FIELD_INSPECTION_DATE` | 子課題・明細管理寄り |
| 支払予定日 | `BACKLOG_FIELD_PAYMENT_PLANNED_DATE` | 子課題・明細管理寄り |

## 納品リクエスト

### 確定方針

- 現状維持
- 既存の Backlog 項目構成を当面維持する

### 残す候補

| 項目 | `.env` | 理由 |
|---|---|---|
| 親課題キー | `BACKLOG_FIELD_PARENT_ISSUE_KEY` | 後続課題の起点 |
| 明細番号 | `BACKLOG_FIELD_ITEM_NO` | 明細と結ぶ主キー |
| 納品備考 | `BACKLOG_FIELD_DELIVERY_NOTE` | 最小補足として有効 |

### DBへ移す候補

| 項目 | `.env` | 理由 |
|---|---|---|
| 今回納品金額 | `BACKLOG_FIELD_DELIVERED_AMOUNT` | 明細ロジック寄り |
| 検収日 | `BACKLOG_FIELD_INSPECTION_DATE` | 納品イベント寄り |
| 支払予定日 | `BACKLOG_FIELD_PAYMENT_PLANNED_DATE` | 支払処理寄り |

## 利用許諾料計算

### 確定方針

- 現状維持
- 既存の Backlog 項目構成を当面維持する

### 残す候補

| 項目 | `.env` | 理由 |
|---|---|---|
| 紐付けライセンス課題キー | `BACKLOG_FIELD_LICENSE_KEY` | 起点キー |
| 製品名 | `BACKLOG_FIELD_PRODUCT_NAME` | 一覧識別に有効 |
| 製造完了日 | `BACKLOG_FIELD_COMPLETION_DATE` | 期限起点として重要 |
| 報告対象期間終了 | `BACKLOG_FIELD_REPORT_PERIOD_END` | 売上報告ベースの起点 |
| 数量 | `BACKLOG_FIELD_QUANTITY` | 最小計算情報 |
| MSRP | `BACKLOG_FIELD_MSRP` | 最小計算情報 |

### DBへ移す候補

| 項目 | `.env` | 理由 |
|---|---|---|
| 版 | `BACKLOG_FIELD_EDITION` | 補助情報 |
| サンプル数 | `BACKLOG_FIELD_SAMPLE_QUANTITY` | 補助情報 |
| 報告対象期間開始 | `BACKLOG_FIELD_REPORT_PERIOD_START` | 運用上の重要度が低い |
| 売上高 | `BACKLOG_FIELD_NET_SALES` | 詳細計算値として DB 寄り |
| 報告期限 | `BACKLOG_FIELD_S1_REPORT_DUE` | 自動算出対象に寄せたい |
| 支払期限 | `BACKLOG_FIELD_S1_PAYMENT_DUE` | 自動算出対象に寄せたい |

## 個別利用許諾条件

### 確定方針

- Backlog に残す
  - `親ライセンス課題キー`
  - `許諾開始日`
- DB へ移す
  - 上記以外すべて

### 残す候補

| 項目 | `.env` | 理由 |
|---|---|---|
| 親ライセンス課題キー | `BACKLOG_FIELD_LICENSE_KEY` | 主キー |
| ライセンス種別名 | `BACKLOG_FIELD_LICENSE_TYPE_NAME` | 今後は DB へ移す前提。移行完了までの暫定候補 |
| 許諾開始日 | `BACKLOG_FIELD_LICENSE_START` | 条件起点として継続 |
| 地域・言語 | `BACKLOG_FIELD_TERRITORY` | 今後は DB へ移す前提。移行完了までの暫定候補 |

### DBへ移す候補

| 項目 | `.env` | 理由 |
|---|---|---|
| 素材番号 | `BACKLOG_FIELD_MATERIAL_CODE` | 詳細補助情報 |
| 素材名 | `BACKLOG_FIELD_MATERIAL_NAME` | 詳細補助情報 |
| 素材権利者 | `BACKLOG_FIELD_MATERIAL_RIGHTS_HOLDER` | 詳細補助情報 |
| 監修者 | `BACKLOG_FIELD_SUPERVISOR` | 詳細補助情報 |

### 削除候補

| 項目 | `.env` | 理由 |
|---|---|---|
| 条件1 地域・言語ラベル | `BACKLOG_FIELD_CONDITION1_REGION_LANGUAGE_LABEL` | 表示専用で冗長 |
| 条件1 計算方式 | `BACKLOG_FIELD_CONDITION1_CALC_METHOD` | UI / DB 側管理向き |
| 条件1 計算式 | `BACKLOG_FIELD_CONDITION1_FORMULA` | 複雑で Backlog 不向き |
| 条件1 基準価格ラベル | `BACKLOG_FIELD_CONDITION1_BASE_PRICE_LABEL` | 表示専用 |
| 条件1 料率 | `BACKLOG_FIELD_CONDITION1_RATE` | 詳細条件 |
| 条件1 支払条件 | `BACKLOG_FIELD_CONDITION1_PAYMENT_TERMS` | 詳細条件 |
| 条件1 MG/AG | `BACKLOG_FIELD_CONDITION1_MG_AG` | 詳細条件 |
| 条件1 補足 | `BACKLOG_FIELD_CONDITION1_NOTE` | 詳細条件 |
| 条件2 見出し | `BACKLOG_FIELD_CONDITION2_HEADING` | 表示専用 |
| 条件2 地域 | `BACKLOG_FIELD_CONDITION2_REGION` | 詳細条件 |
| 条件2 言語 | `BACKLOG_FIELD_CONDITION2_LANGUAGE` | 詳細条件 |
| 条件2 計算方式 | `BACKLOG_FIELD_CONDITION2_CALC_METHOD` | 詳細条件 |
| 条件2 概要 | `BACKLOG_FIELD_CONDITION2_SUMMARY` | 詳細条件 |
| 条件2 計算式 | `BACKLOG_FIELD_CONDITION2_FORMULA` | 詳細条件 |
| 条件2 分配率 | `BACKLOG_FIELD_CONDITION2_SHARE_RATE` | 詳細条件 |
| 条件2 支払条件 | `BACKLOG_FIELD_CONDITION2_PAYMENT_TERMS` | 詳細条件 |
| 条件2 MG/AG | `BACKLOG_FIELD_CONDITION2_MG_AG` | 詳細条件 |
| 条件2 補足 | `BACKLOG_FIELD_CONDITION2_NOTE` | 詳細条件 |
| 条件3 見出し | `BACKLOG_FIELD_CONDITION3_HEADING` | 表示専用 |
| 条件3 地域 | `BACKLOG_FIELD_CONDITION3_REGION` | 詳細条件 |
| 条件3 言語 | `BACKLOG_FIELD_CONDITION3_LANGUAGE` | 詳細条件 |
| 条件3 計算方式 | `BACKLOG_FIELD_CONDITION3_CALC_METHOD` | 詳細条件 |
| 条件3 概要 | `BACKLOG_FIELD_CONDITION3_SUMMARY` | 詳細条件 |
| 条件3 計算式 | `BACKLOG_FIELD_CONDITION3_FORMULA` | 詳細条件 |
| 条件3 料率 | `BACKLOG_FIELD_CONDITION3_RATE` | 詳細条件 |
| 条件3 支払条件 | `BACKLOG_FIELD_CONDITION3_PAYMENT_TERMS` | 詳細条件 |
| 条件3 MG/AG | `BACKLOG_FIELD_CONDITION3_MG_AG` | 詳細条件 |
| 条件3 補足 | `BACKLOG_FIELD_CONDITION3_NOTE` | 詳細条件 |

## 初回削減の優先順

最初に削るなら、影響の少ない順に次を推奨する。

1. 表示専用・説明専用の項目
   - `CONDITION*_HEADING`
   - `CONDITION*_SUMMARY`
   - `*_LABEL` 系
2. 素材情報群
   - `MATERIAL_*`
   - `SUPERVISOR`
3. 金銭条件の詳細群
   - `CONDITION1_*`
   - `CONDITION2_*`
   - `CONDITION3_*`
4. 明細・検収・支払の補助日付
   - `INSPECTION_DATE`
   - `PAYMENT_PLANNED_DATE`
5. Vendor / 帳票補完できるヘッダ補助項目
   - `COUNTERPARTY_ADDRESS`
   - `COUNTERPARTY_REP`
   - `BANK_INFO`

## 最低限残す Backlog 項目セット

「Backlog はステータス管理＋課題補足のみ」とする場合、まずは次を中核セットとする案が現実的である。

- 件名
- 課題タイプ
- ステータス
- 期限日
- 契約日
- 契約期間
- 発注日
- 案件名
- 親課題キー
- 親ライセンス課題キー
- 許諾開始日
- 納品リクエスト現行項目
- 利用許諾料計算現行項目

## 次の実施順

1. Backlog カスタム属性の削減対象を確定する
2. `BACKLOG_FIELD_*` の必須判定を新方針に合わせて見直す
3. Slack モーダルと Backlog 起票項目を新方針に合わせる
4. DB 保存先と管理 UI の表示項目を不足なく補う
5. 不要になった warning / health check を整理する

## 実施前の確認ポイント

- 画面表示だけでなく、テンプレート生成や同期処理で参照していないか確認する
- `BACKLOG_FIELD_*` を削る前に、warning 判定ロジックと health 表示を整理する
- Slack モーダルの最小項目と差が出ないよう、先に入力仕様を確定する
- 管理 UI / DB に移す項目は、代替の保持先が先に存在することを確認する

## 関連資料

- [Slack Modal Field Inventory](C:/Users/tatsuya.kuramochi/Desktop/legalbrigde-proto_GCP/docs/development/SLACK_MODAL_FIELD_INVENTORY.md)
- [Slack Modal Minimum Fields Final](C:/Users/tatsuya.kuramochi/Desktop/legalbrigde-proto_GCP/docs/development/SLACK_MODAL_MINIMUM_FIELDS_FINAL.md)
- [Slack To Backlog Mapping](C:/Users/tatsuya.kuramochi/Desktop/legalbrigde-proto_GCP/docs/development/SLACK_TO_BACKLOG_MAPPING.md)
- [Backlog Field Mapping Guide](C:/Users/tatsuya.kuramochi/Desktop/legalbrigde-proto_GCP/docs/development/BACKLOG_FIELD_MAPPING_GUIDE.md)
