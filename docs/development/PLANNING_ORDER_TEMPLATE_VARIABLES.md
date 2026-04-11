# 企画発注書テンプレート変数一覧

対象テンプレート:

- `templates/template_order_planning.html`

対象生成コード:

- `src/orders/generator.ts`
- `src/orders/csvImport.ts`
- `src/orders/planningImportSettings.ts`

## 1. ヘッダ・基本情報

- `ORDER_NO`
- `ORDER_DATE_YEAR`
- `ORDER_DATE_MONTH`
- `ORDER_DATE_DAY`
- `PROJECT_TITLE`
- `PAYMENT_TERMS`
- `FIRST_DRAFT_DEADLINE`
- `FINAL_DEADLINE`
- `MASTER_CONTRACT_REF`

## 2. 発注者情報

- `PARTY_A_NAME`
- `PARTY_A_ADDRESS`
- `PARTY_A_REP`
- `STAFF_DEPARTMENT`
- `STAFF_NAME`
- `STAFF_PHONE`
- `STAFF_EMAIL`

## 3. 受注者情報

- `VENDOR_NAME`
- `VENDOR_SUFFIX`
- `VENDOR_ADDRESS`
- `VENDOR_EMAIL`
- `VENDOR_CONTACT_DEPARTMENT`
- `VENDOR_CONTACT_NAME`
- `VENDOR_ACCEPT_DATE`
- `VENDOR_ACCEPT_NAME`

補足:

- 現在の生成コードでは `VENDOR_CONTACT_NAME` は埋まります
- `VENDOR_ACCEPT_NAME` はテンプレート上の任意欄で、現状は明示セットしていません

## 4. 振込・請求情報

- `BANK_INFO`
- `BANK_NAME`
- `BRANCH_NAME`
- `ACCOUNT_TYPE`
- `ACCOUNT_NUMBER`
- `ACCOUNT_HOLDER_KANA`
- `INVOICE_REGISTRATION_NUMBER`
- `TRANSFER_FEE_PAYER`

## 5. 条件・備考

- `SPECIAL_TERMS`
- `REMARKS`
- `ACCEPT_METHOD`
- `ACCEPT_REPLY_DUE_DATE`

## 6. 明細配列 `items[]`

各明細で使う変数:

- `category`
- `item_name`
- `detailText`
- `payment_method_display`
- `qty`
- `deliveryDateStr`
- `rightsLabel`

補足:

- 生成コード側では `unitPrice`、`amount`、`transfer_fee` も持っています
- ただし `template_order_planning.html` で直接参照している主要項目は上記です

## 7. 現行マッピング設定から主に入る項目

### 列マッピング

- `projectTitleSource`
- `projectTitleManualValue`
- `vendorLookupColumn`
- `vendorCodeColumn`
- `itemNameColumn`
- `completionDateColumn`
- `completionDateFallbackColumn`
- `finalDeadlineColumn`
- `quantityColumn`
- `unitPriceColumn`
- `amountColumn`
- `amountFallbackColumn`
- `detailColumns`

### 固定値・初期値

- `constants.category`
- `constants.payMethod`
- `constants.rightsLabel`
- `constants.transferFee`
- `constants.transferFeePayer`
- `constants.deliveryDateLabel`
- `constants.paymentDateLabel`
- `constants.finalDeadlineFallback`
- `defaults.specialTerms`
- `defaults.remarks`
- `defaults.acceptMethod`
- `defaults.acceptReplyDueDate`

## 8. 出版一括発注書で差し替え候補になりやすい項目

- `projectTitleManualValue`
- `vendorLookupColumn`
- `vendorCodeColumn`
- `itemNameColumn`
- `completionDateColumn`
- `completionDateFallbackColumn`
- `finalDeadlineColumn`
- `amountColumn`
- `amountFallbackColumn`
- `detailColumns`
- `constants.category`
- `constants.rightsLabel`
- `constants.deliveryDateLabel`
- `constants.paymentDateLabel`
- `defaults.specialTerms`
- `defaults.remarks`

## 9. 実装メモ

- 現在は `planning` と `publishing_bulk` の 2 プロファイルを持つ
- CSV取込画面で使用プロファイルを選択する
- マッピング設定画面で編集中のプロファイルを切り替える
- `publishing_bulk` の初期値は `書名 / 初校締切 / 校了予定 / 発注金額 / ISBN` を含む出版進行表向けに寄せている
