# Slack Modal Field Inventory

## 目的

現行の Slack モーダル項目を棚卸しし、次の 3 区分で整理する。

- `残す`
- `Backlog に寄せる`
- `廃止候補`

今回の前提は次の通り。

- `Slack -> Backlog` を受付主線にする
- `Local / DB` は補助系に分離する
- `納期 / 検収日 / 支払予定日 / 報告期限 / 支払期限` は Backlog を正本にする
- `発注明細` は Slack モーダルで持たない

## 判定ルール

### 残す

- 起票時に人が入力しないと課題が作れない
- 受付の時点で意味が確定している
- 後続課題の起点になる

### Backlog に寄せる

- 起票時に必須ではない
- 後続処理や API 同期で決められる
- 期限や状態として Backlog で持ったほうが運用しやすい

### 廃止候補

- Slack で入れても後で上書きされる
- CSV / Local / DB で持つほうが自然
- 帳票生成の補助値であり、受付主線では不要

## 共通項目

| 項目 | blockId | 判定 | 理由 | 代替・正本 |
|---|---|---|---|---|
| 依頼種別 | `contract_type` | 残す | 起票先の課題タイプを決める | Slack |
| 件名 | `summary` | 残す | 課題作成に必須 | Slack / Backlog |
| 依頼内容 | `notes` | 残す | 起票本文の最低限情報 | Slack / Backlog |
| 希望納期 | `deadline` | 条件付きで残す | 契約系では有効、発注・計算では後続管理に寄せたい | Backlog |
| 相手先名 | `counterparty` | 条件付きで残す | 親課題ヘッダに必要な種別のみ Slack で持つ | Slack / Backlog |
| 添付ファイル | `request_attachments` | 残す | レビュー依頼・相談で重要 | Slack |
| 登録番号 | `registration_number` | 条件付きで残す | 契約・売買系では識別に有効、後続課題では不要 | Slack / Backlog |
| 相手方住所 | `counterparty_address` | Backlog に寄せる | Vendor 補完できることが多く、Slack 初回入力には重い | Backlog / DB |
| 相手方代表者 | `counterparty_representative` | Backlog に寄せる | Vendor 補完できることが多く、Slack 初回入力には重い | Backlog / DB |
| 備考 | `remarks` | 残す | 補足メモとして必要 | Slack / Backlog |

## 契約系

| 項目 | blockId | 対象 | 判定 | 理由 | 代替・正本 |
|---|---|---|---|---|---|
| 契約日 | `contract_date` | NDA 等 | 残す | 契約本文に直結 | Slack / Backlog |
| 契約期間 | `contract_period` | NDA | 残す | 主要条件 | Slack / Backlog |
| 管轄裁判所 | `jurisdiction` | ライセンス / 海外IP | 残す | 主要条件 | Slack / Backlog |
| 秘密保持の目的 | `nda_purpose` | NDA | 残す | NDA の主目的 | Slack / Backlog |
| 原著作物 | `original_work` | ライセンス系 | 残す | 親ライセンス識別に必要 | Slack / Backlog |
| 原著作者 | `original_author` | ライセンス契約 | Backlog に寄せる | Slack 起票の成立には不要 | Backlog |
| クレジット表記 | `credit_name` | ライセンス契約 | Backlog に寄せる | Slack 起票後に補完しやすい | Backlog |
| 承継覚書日付 | `succession_memorandum_date` | ライセンス契約 | Backlog に寄せる | 例外条件寄りで初回起票では不要 | Backlog |

## 個別利用許諾条件

| 項目 | blockId | 判定 | 理由 | 代替・正本 |
|---|---|---|---|---|
| 親ライセンス課題キー | `license_issue_key` | 残す | 後続計算の起点 | Slack / Backlog |
| 許諾区分 | `license_type_name` | 残す | 条件の識別子 | Slack / Backlog |
| 許諾開始日 | `license_start` | 残す | 条件開始の基準 | Slack / Backlog |
| 地域・言語 | `territory` | 残す | 許諾ヘッダの最小条件として必要 | Slack / Backlog |
| 計算方法表示 | `calculation_method_label` | 廃止候補 | 表示専用で受付主線では不要 | Local / DB |
| 料率表示 | `rate_label` | 廃止候補 | 表示専用で受付主線では不要 | Local / DB |
| 支払条件表示 | `payment_terms_label` | 廃止候補 | 表示専用で受付主線では不要 | Local / DB |
| MG/AG表示 | `mg_ag_label` | 廃止候補 | 表示専用で受付主線では不要 | Local / DB |
| 素材情報群 | `material_*` | 廃止候補 | 詳細条件の補助情報 | Local / DB |
| 金銭条件1-3 | `money1_*` `money2_*` `money3_*` | 廃止候補 | Slack で入れるには重い | Local / DB |

## 売買契約

| 項目 | blockId | 判定 | 理由 | 代替・正本 |
|---|---|---|---|---|
| 商品範囲 | `product_scope` | 残す | 契約の対象そのもの | Slack / Backlog |
| 納入場所 | `delivery_location` | Backlog に寄せる | 物流運用の詳細で後追いしやすい | Backlog |
| 検収期間 | `inspection_period_days` | Backlog に寄せる | 運用条件として後追いしやすい | Backlog |
| 支払条件概要 | `payment_condition_summary` | 残す | 主要条件 | Slack / Backlog |
| 保証期間 | `warranty_period` | Backlog に寄せる | 後から埋めやすい | Backlog |
| 月末締め日 | `monthly_closing_day` | Backlog に寄せる | 回収運用の詳細で後追いしやすい | Backlog |
| 支払期日 | `payment_due_day` | Backlog に寄せる | 回収運用の詳細で後追いしやすい | Backlog |
| 支払方法 | `payment_method` | Backlog に寄せる | 回収運用の詳細で後追いしやすい | Backlog |
| 保証金額 | `security_deposit_amount` | 残す | 保証金掛け売りの主条件 | Slack / Backlog |
| 保証金補充期限 | `deposit_replenish_days` | 残す | 保証金掛け売りの主条件 | Slack / Backlog |

## 発注書

| 項目 | blockId | 判定 | 理由 | 代替・正本 |
|---|---|---|---|---|
| 発注日 | `contract_date` | Backlog に寄せる | 起票後に補完でき、Slack 初回入力の必須度が低い | Backlog |
| 案件名 | `project_title` | 残す | 親課題ヘッダに必要 | Slack / Backlog |
| マスター契約参照 | `master_contract_ref` | Backlog に寄せる | Vendor / DB 補完と併用しやすい | Backlog / DB |
| 発注概要 | `order_summary` | 条件付きで残す | 単純発注では必要、詳細は後続で補完 | Slack / Backlog |

## 企画発注書

| 項目 | blockId | 判定 | 理由 | 代替・正本 |
|---|---|---|---|---|
| 発注日 | `contract_date` | Backlog に寄せる | 起票後に補完できる | Backlog |
| 案件名 | `project_title` | 残す | 親課題ヘッダ | Slack / Backlog |
| マスター契約参照 | `master_contract_ref` | Backlog に寄せる | 参照キーだが初回入力は必須でない | Backlog |

## 出版発注書

| 項目 | blockId | 判定 | 理由 | 代替・正本 |
|---|---|---|---|---|
| 発注日 | `contract_date` | Backlog に寄せる | 起票後に補完できる | Backlog |
| 案件名 | `project_title` | 残す | 親課題ヘッダ | Slack / Backlog |
| マスター契約参照 | `master_contract_ref` | 残す | 基本契約参照に必要 | Slack / Backlog |
| 進行概要 | `order_summary` | 残す | 全体進行の要約として有効 | Slack / Backlog |
| 初校締切 | 将来候補 | Backlog に寄せる | CSV / 子課題で管理すべき | Backlog |
| 再校締切 | 将来候補 | Backlog に寄せる | CSV / 子課題で管理すべき | Backlog |
| 校了予定 | 将来候補 | Backlog に寄せる | 子課題の期日として管理 | Backlog |
| 検収日 | 将来候補 | Backlog に寄せる | 検収書一括作成で再取込する | Backlog |
| 支払予定日 | 将来候補 | Backlog に寄せる | 子課題の期日として管理 | Backlog |

## 納品リクエスト

| 項目 | blockId | 判定 | 理由 | 代替・正本 |
|---|---|---|---|---|
| 親課題キー | `parent_issue_key` | 残す | 後続課題の起点 | Slack / Backlog |
| 明細番号 | `item_no` | 残す | 1明細1課題で必要 | Slack / Backlog |
| 今回納品金額 | `delivered_amount` | Backlog に寄せる | 納品開始後に確定しやすく、Slack 初回入力の必須度が低い | Backlog / Local |
| 納品備考 | `delivery_note` | 残す | 帳票備考に使う | Slack / Backlog |
| 検収日 | 将来候補 | Backlog に寄せる | 一括検収書作成で管理 | Backlog |
| 支払予定日 | 将来候補 | Backlog に寄せる | 支払通知書管理に有効 | Backlog |

## 利用許諾料計算

| 項目 | blockId | 判定 | 理由 | 代替・正本 |
|---|---|---|---|---|
| 紐付けライセンス課題キー | `license_issue_key` | 残す | 計算の起点 | Slack / Backlog |
| 製品名 | `product_name` | 残す | 案件識別に必要 | Slack / Backlog |
| 版 | `edition` | Backlog に寄せる | 任意値で後から埋めやすい | Backlog |
| 製造完了日 | `completion_date` | 残す | 製造ベースの期限起点 | Slack / Backlog |
| 製造数量 | `quantity` | 残す | 計算基礎値 | Slack / Backlog |
| MSRP | `msrp` | 残す | 計算基礎値 | Slack / Backlog |
| サンプル数 | `sample_quantity` | Backlog に寄せる | 任意で後追い可能 | Backlog |
| 備考 | `remarks` | 残す | 補足メモ | Slack / Backlog |
| 報告対象期間開始 | `report_period_start` | Backlog に寄せる | 期間終了日があれば計算起点と整合を取りやすい | Backlog |
| 報告対象期間終了 | `report_period_end` | 残す | 売上報告ベースの期限起点 | Slack / Backlog |
| 売上高 | `sales_amount` | 残す | 計算基礎値 | Slack / Backlog |
| 受領額 | `received_amount` | Backlog に寄せる | 再許諾系では有効だが初回起票の必須度は低い | Backlog |
| 販売数量 | `sales_quantity` | Backlog に寄せる | 必須度が低い | Backlog |
| 報告期限 | 将来候補 | Backlog に寄せる | completion/report_end から同期したい | Backlog |
| 支払期限 | 将来候補 | Backlog に寄せる | completion/report_end から同期したい | Backlog |

## 今回の優先整理対象

今回追加前に優先して確認したいもの。

### 残す候補

- `project_title`
- `parent_issue_key`
- `item_no`
- `license_issue_key`
- `completion_date`
- `report_period_end`
- `quantity`
- `msrp`

### Backlog に寄せる候補

- `検収日`
- `支払予定日`
- `報告期限`
- `支払期限`
- `初校締切`
- `再校締切`
- `校了予定`

### 廃止候補

- `calculation_method_label`
- `rate_label`
- `payment_terms_label`
- `mg_ag_label`
- `money1_*`
- `money2_*`
- `money3_*`
- `material_*`

## 確認時の観点

- 起票時に本当に必要か
- 後続課題の主キーになるか
- Backlog の正本にすべきか
- Local / DB の補助値で十分か
- Slack 入力を減らしたほうが運用しやすいか
