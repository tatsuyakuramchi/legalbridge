# IGLA Input Redesign

## 目的

Backlog のカスタム属性が上限 (`100 / 100`) に達しているため、海外IP契約（IGLA系）の詳細条件は Backlog に積み増さず、入力フォーム側の長文入力で受ける構成へ整理する。

## 方針

- Backlog は `案件管理` に必要な最小項目だけ保持する
- 契約本文に必要な詳細条件は `Slack モーダル / 管理UI の長文入力` で受ける
- テンプレートは `細粒度変数` ではなく `長文ブロック` を優先して差し込む
- 将来 API 化する場合は、Backlog ではなく `DB または JSON ドラフト` に保存する

## Backlog に残す項目

### 基本契約

- `registration_number`
- `counterparty`
- `counterparty_address`
- `counterparty_representative`
- `contract_date`
- `contract_no`
- `original_work`
- `territory`
- `deal_structure`
- `exclusivity`
- `revenue_model`
- `contract_period`
- `jurisdiction`
- `special_notes`
- `remarks`

### 変更合意

- `registration_number`
- `counterparty`
- `counterparty_address`
- `counterparty_representative`
- `contract_date`
- `base_agreement_key`
- `effective_date`
- `change_mode`
- `deal_structure`
- `original_work`
- `territory`
- `revenue_model`
- `amendment_clauses`
- `special_notes`
- `remarks`

## フォーム側へ寄せる項目

### 基本契約

- `license_scope`
- `ip_product_scope`
- `royalty_terms`
- `sublicense_allowed`
- `title_transfer_model`
- `inventory_selloff`
- `schedule_1_summary`
- `schedule_1_special_provisions`
- `schedule_2_summary`
- `schedule_2_special_provisions`

### 変更合意

- `license_scope`
- `ip_product_scope`
- `royalty_terms`
- `title_transfer_model`
- `inventory_selloff`
- `schedule_1_summary`
- `schedule_1_special_provisions`
- `schedule_2_summary`
- `schedule_2_special_provisions`

## テンプレート変数の再編方針

### 現行

- `S1_ROYALTY_RATE`
- `S1_MINIMUM_GUARANTEE`
- `S1_ADVANCE`
- `...`
- `S2_MARKETPLACE_ONLINE_SALES`
- `S2_ADDITIONAL_TERMS`

### 変更後

- `SCHEDULE_1_SUMMARY`
- `SCHEDULE_1_SPECIAL_PROVISIONS`
- `SCHEDULE_2_SUMMARY`
- `SCHEDULE_2_SPECIAL_PROVISIONS`

## 入力UIイメージ

### Schedule 1 Summary

- ロイヤルティ率
- MG / Advance
- 会計期間
- レポート期限 / 支払期限
- 初回製造数量
- 発売目標日
- 献本条件
- クレジット表記

### Schedule 1 Special Provisions

- Consumer law carve-out
- VAT / GST
- Copyright registration
- Moral rights
- Mandatory distribution law
- その他特約

### Schedule 2 Summary

- SKU / Price / MOQ
- MPR
- Incoterms
- Arrival point
- Advance / Balance
- Currency

### Schedule 2 Special Provisions

- Import / customs
- Consumer product safety
- Distribution law protections
- VAT / GST on supply
- Product liability insurance
- Marketplace / online sales
- その他特約

## 実装ステップ

1. `ip_overseas_master` / `ip_overseas_amendment` の入力定義を長文ブロック方式へ整理
2. Slack / 管理UI で `schedule_1_summary` などの長文項目を受ける
3. Backlog カスタム属性の追加を止め、既存の最小属性だけ送る
4. テンプレートを `S1_* / S2_*` から長文ブロック差し込みへ変更
5. 既存の細粒度変数は互換のため一時残して、段階的に削除

## 補足

- Backlog は今後 `検索・期限・親子関係・ステータス管理` に専念させる
- 本文ドラフトの再編集が必要な場合は、Backlog ではなく `ドキュメントドラフト保存` 側に寄せるのが安全
- 詳細条件を無理に Backlog に持たせると、IGLA 以外の契約類型にも同じ問題が再発する
