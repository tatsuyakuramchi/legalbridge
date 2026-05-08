# Backlog/DB/文書/CSV 統合設計一覧

更新日: 2026-04-17  
対象リポジトリ: `legalbrigde-proto_GCP`

## 1. Backlog カスタム属性一覧（最小運用 + 実装反映）

### 1-1. 最小運用の基準属性（`src/cli/ensureBacklogMinimumFields.ts`）

| envキー | 属性名（推奨） | 型 | 主用途 |
|---|---|---|---|
| `BACKLOG_FIELD_CONTRACT_DATE` | 契約日・発注日 | 日付 | 契約/発注ヘッダ日付 |
| `BACKLOG_FIELD_CONTRACT_PERIOD` | 契約期間 | 文字列 | 契約期間の補足 |
| `BACKLOG_FIELD_REMARKS` | 備考 | 複数行文字列 | 共通補足 |
| `BACKLOG_FIELD_CONTRACT_NO` | 文書番号 | 文字列 | 採番番号保持 |
| `BACKLOG_FIELD_PROJECT_TITLE` | 案件名 | 文字列 | 発注系ヘッダ |
| `BACKLOG_FIELD_MASTER_CONTRACT_REF` | master_contract_ref | 文字列 | 基本契約参照 |
| `BACKLOG_FIELD_LICENSE_KEY` | 親ライセンス課題キー | 文字列 | ライセンス参照 |
| `BACKLOG_FIELD_LICENSE_TYPE_NAME` | 許諾区分 | 文字列 | 個別利用許諾条件 |
| `BACKLOG_FIELD_LICENSE_START` | 許諾開始日 | 日付 | 個別利用許諾条件 |
| `BACKLOG_FIELD_TERRITORY` | 許諾地域・言語 | 文字列 | 個別利用許諾条件 |
| `BACKLOG_FIELD_PARENT_ISSUE_KEY` | 親課題キー | 文字列 | 納品親参照 |
| `BACKLOG_FIELD_ITEM_NO` | 明細番号 | 文字列 | 納品対象明細 |
| `BACKLOG_FIELD_DELIVERY_NOTE` | 納品備考 | 複数行文字列 | 納品補足 |
| `BACKLOG_FIELD_FINAL_DEADLINE` | 納期 / 校了予定 | 日付 | 納品管理期日 |
| `BACKLOG_FIELD_INSPECTION_DATE` | 検収日 | 日付 | 検収管理 |
| `BACKLOG_FIELD_PAYMENT_PLANNED_DATE` | 支払予定日 | 日付 | 支払予定管理 |
| `BACKLOG_FIELD_PRODUCT_NAME` | 製品名 / 対象商品名 | 文字列 | ロイヤリティ計算 |
| `BACKLOG_FIELD_EDITION` | 版 | 文字列 | 製造計算補足 |
| `BACKLOG_FIELD_COMPLETION_DATE` | 製造完了日 | 日付 | 製造基準日 |
| `BACKLOG_FIELD_QUANTITY` | 数量 | 数値 | 製造数量 |
| `BACKLOG_FIELD_MSRP` | MSRP | 数値 | 基準価格 |
| `BACKLOG_FIELD_SAMPLE_QUANTITY` | サンプル数量 | 数値 | 計算控除用 |
| `BACKLOG_FIELD_REPORT_PERIOD_START` | 報告対象期間開始 | 日付 | 売上報告計算 |
| `BACKLOG_FIELD_REPORT_PERIOD_END` | 報告対象期間終了 | 日付 | 売上報告計算 |
| `BACKLOG_FIELD_NET_SALES` | 売上高・正味売上高 | 数値 | 売上報告計算 |
| `BACKLOG_FIELD_S1_REPORT_DUE` | 報告期限 | 日付 | 期限管理 |
| `BACKLOG_FIELD_S1_PAYMENT_DUE` | 支払期限 | 日付 | 期限管理 |

### 1-2. 共通基準として常時チェックされる属性（`src/backlog/configValidator.ts`）

- `BACKLOG_FIELD_COUNTERPARTY`（相手方）
- `BACKLOG_FIELD_DEADLINE`（希望期限）
- `BACKLOG_FIELD_REMARKS`（備考）

## 2. Backlog ステータス一覧

### 2-1. 文書ワークフローステータス（`src/workflow/statusConfig.ts`）

| 論理キー | デフォルト名称 | env上書きキー |
|---|---|---|
| documentRequested | 文書生成依頼 | `BACKLOG_STATUS_DOCUMENT_REQUESTED` |
| draft | 草案 | `BACKLOG_STATUS_DRAFT` |
| review | 草案（デフォルトでdraftと同値） | `BACKLOG_STATUS_REVIEW` |
| approvalPending | 承認待ち | `BACKLOG_STATUS_APPROVAL_PENDING` |
| counterpartyPending | 相手方確認待ち | `BACKLOG_STATUS_COUNTERPARTY_PENDING` |
| cloudSignPreparing | クラウドサイン送信準備 | `BACKLOG_STATUS_CLOUDSIGN_PREPARING` |
| stampPending | 押印依頼中 | `BACKLOG_STATUS_STAMP_PENDING` |
| signed | 締結済 | `BACKLOG_STATUS_SIGNED` |
| completed | 完了 | `BACKLOG_STATUS_COMPLETED` |
| discarded | 破棄 | `BACKLOG_STATUS_DISCARDED` |

### 2-2. 納品・一般処理で使う運用ステータス（Webhook実装）

- `未対応`（初期）
- `処理中`（納品受付トリガ）
- `処理済み`（検収書/支払通知書生成トリガ）
- `完了`

## 3. 課題起案（Slack起票）一覧

`src/workflow/documentRequestConfig.ts` / `src/workflow/documentRequestFields.ts` に基づく。

| requestType | 表示名 | Backlog課題タイプ | workflowKind | 主な起票入力（要点） |
|---|---|---|---|---|
| `legal_consultation` | 法務相談 | 法務相談 | primary | 相手方/相談背景/相談内容 |
| `nda` | 秘密保持契約（NDA） | NDA | primary | 契約日, 契約期間 |
| `outsourcing` | 業務委託基本契約 | 業務委託基本契約 | primary | 契約日, 契約期間 |
| `license` | ライセンス契約 | ライセンス契約 | primary | 契約日, 契約期間 |
| `license_schedule` | 個別利用許諾条件 | 個別利用許諾条件 | primary | 親ライセンス課題キー, 許諾開始日 |
| `ip_overseas_master` | 海外IP契約（基本契約） | 海外IP契約（基本契約） | primary | 契約日, 契約期間 |
| `ip_overseas_amendment` | 海外IP契約（変更合意） | 海外IP契約（変更合意） | primary | 変更合意日, 契約期間 |
| `sales_buyer` | 売買契約（当社買手） | 売買契約（当社買手） | primary | 契約日, 契約期間 |
| `sales_seller_standard` | 売買契約（当社売手・標準） | 売買契約（当社売手・標準） | primary | 契約日, 契約期間 |
| `sales_seller_credit` | 売買契約（当社売手・保証金掛け売り） | 売買契約（当社売手・保証金掛け売り） | primary | 契約日, 契約期間 |
| `purchase_order` | 発注書 | 発注書 | primary | 発注日, 案件名 |
| `planning_order` | 企画発注書 | 企画発注書 | primary | 発注日, 案件名 |
| `publishing_order` | 出版発注書 | 出版発注書 | primary | 発注日, 案件名 |
| `delivery_request` | 納品リクエスト | 納品リクエスト | followup | 親課題キー, 明細番号, 納品備考 |
| `royalty_calculation_manufacturing` | 利用許諾料計算（製造ベース） | 製造案件 | followup | ライセンス課題キー, 製造完了日, 数量, MSRP |
| `royalty_calculation_sales_report` | 利用許諾料計算（売上報告ベース） | 売上報告案件 | followup | ライセンス課題キー, 報告期間終了, 売上高 |

## 4. DB テーブル一覧と主な挿入項目

スキーマ: `prisma/schema.prisma`  
実際の挿入/更新ロジック: `src/db/repository.ts`, `src/db/orderRepository.ts`

| テーブル | 主キー/ユニーク | 主な挿入項目（create/upsertの中心） |
|---|---|---|
| `Vendor` | `id`, `vendorCode` unique | `vendorCode`, `vendorName`, `address`, `email`, `bankName`, `invoiceRegistrationNumber` など |
| `Staff` | `id`, `slackUserId` unique | `slackUserId`, `staffName`, `department`, `departmentCode`, `partyA*` |
| `DepartmentWorkflowRule` | `id`, `department` unique | `department`, `approverSlackId`, `stampOperatorSlackId`, `managerSlackId`, `isActive` |
| `LegalRequest` | `id`, `backlogIssueKey` unique | `backlogIssueKey`, `slackUserId`, `contractType`, `counterparty`, `summary`, `deadline`, `notes` |
| `OrderItem` | `id`, `(legalRequestId,itemNo)` unique, `backlogIssueKey` unique | `legalRequestId`, `itemNo`, `vendorCode`, `description`, `amount`, `dueDate`, `latestAmount`, `latestDueDate` |
| `DeliveryEvent` | `id`, `backlogIssueKey` unique | `backlogIssueKey`, `orderItemId`, `deliveryNo`, `deliveredAt`, `deliveredAmount`, `inspectionDeadline`, `note` |
| `ChangeLog` | `id` | `targetType`, `orderItemId`, `fieldName`, `beforeValue`, `afterValue`, `reason`, `changedBy` |
| `OrderDueReminderLog` | `id`, `(orderItemId, reminderType, reminderDate)` unique | `orderItemId`, `reminderType`, `reminderDate` |
| `LicenseContract` | `id`, `backlogIssueKey` unique, `ledgerId` unique | `backlogIssueKey`, `ledgerId`, `licensor`, `originalWork`, `royaltyRate`, `paymentCycle`, `licenseStartDate` |
| `ManufacturingEvent` | `id`, `backlogIssueKey` unique | `backlogIssueKey`, `licenseContractId`, `productName`, `completionDate`, `quantity`, `msrp`, `totalPayment` |
| `RoyaltyPayment` | `id`, `manufacturingEventId` unique | `manufacturingEventId`, `licenseContractId`, `paymentDueDate`, `reportingDeadline`, `totalAmount`, `status` |
| `BacklogSyncState` | `id`, `backlogIssueId/backlogIssueKey` unique | `backlogIssueId`, `backlogIssueKey`, `issueTypeName`, `statusId`, `statusName`, `lastBacklogUpdatedAt` |
| `BacklogSyncRun` | `id` | `triggerSource`, `status`, `issueCount`, `changedCount`, `processedCount`, `failedCount`, `errorMessage` |
| `IssueWorkflow` | `id`, `backlogIssueKey/backlogIssueId` unique | `backlogIssueKey`, `issueTypeName`, `currentStatusName`, `documentDraft`, `generatedDocuments`, 承認/押印タイムスタンプ群 |
| `WorkExecution` | `id`, `executionKey` unique | `executionKey`, `workType`, `issueKey`, `source`, `status`, `attemptCount`, `lastError` |

## 5. アプリ参照リレーション一覧（Backlog/Slack/DB/Drive）

### 5-1. システム間リレーション

| From | Key | To | 用途 |
|---|---|---|---|
| Slack申請 | 受付payload | Backlog課題 | 起票の主線 |
| Backlog課題 | `issueKey` | `LegalRequest.backlogIssueKey` | 受付案件の補助保存 |
| Backlog課題 | `issueKey` | `IssueWorkflow.backlogIssueKey` | ワークフロー状態保存 |
| Backlog課題（ライセンス） | `issueKey` | `LicenseContract.backlogIssueKey` | ライセンス台帳 |
| Backlog課題（製造） | `issueKey` | `ManufacturingEvent.backlogIssueKey` | 製造計算イベント |
| Backlog課題（納品） | `issueKey` | `DeliveryEvent.backlogIssueKey` | 納品/検収イベント |
| DB文書生成結果 | URL | Backlogコメント | 利用者への返却 |
| DB/部署設定 | `driveFolderKey` | Google Drive folder | 保存先解決 |

### 5-2. DB内の主要参照

| 親 | 子 | 関係 |
|---|---|---|
| `LegalRequest` | `OrderItem` | 1:N |
| `OrderItem` | `DeliveryEvent` | 1:N |
| `OrderItem` | `ChangeLog` | 1:N |
| `LicenseContract` | `ManufacturingEvent` | 1:N |
| `ManufacturingEvent` | `RoyaltyPayment` | 1:1 |
| `IssueWorkflow` | 承認/押印状態 | 1レコード集約 |

## 6. 文書種類と活用シーン

出典: `src/documents/templateRegistry.ts`

| 文書種別 | テンプレートキー | 主な活用シーン |
|---|---|---|
| 秘密保持契約書 | `nda` | NDA締結 |
| 業務委託基本契約書 | `service_basic` | 継続委託の基本契約 |
| 売買契約（買手） | `sales_buyer` | 当社買手の売買基本契約 |
| 売買契約（売手・標準） | `sales_seller_standard` | 前払/代引中心の売手契約 |
| 売買契約（売手・掛売） | `sales_seller_credit` | 保証金付き掛売契約 |
| ライセンス基本契約書 | `license_basic` | ライセンス基本条件締結 |
| 個別利用許諾条件（別紙） | `license_ledger` | ライセンス個別条件の明細化 |
| 海外IP契約（基本） | `ip_overseas_master` | 海外IPの基本契約 |
| 海外IP契約（変更合意） | `ip_overseas_amendment` | 基本契約の変更覚書 |
| 発注書（標準） | `order` | 通常発注 |
| 発注書（企画） | `order_planning` | 企画/クリエイター向け発注 |
| スポット約款 | `spot_terms` | マスター契約なし発注時に添付 |
| 検収書 | `inspection` | 納品検収確定 |
| 支払通知書 | `payment_notice` | 支払確定通知 |
| 利用許諾報告書 | `royalty_report` | ロイヤリティ算定報告 |
| レベニューシェア報酬計算書 | `revenue_share_report` | 売上分配型報酬計算 |

## 7. CSV一括作成設計

実装出典: `src/orders/csvImport.ts`, `src/orders/planningImportSettings.ts`, `data/settings/planning-import.json`

### 7-1. 方式

- `generic` モード: 汎用CSV（列エイリアスで読取）
- `planning` モード: 企画/出版向け設定プロファイルで読取
  - `planning` プロファイル
  - `publishing_bulk` プロファイル（固定ヘッダ厳格）

### 7-2. generic モードの想定列（代表）

| 論理項目 | 受理ヘッダ例 |
|---|---|
| 明細番号 | `no`, `番号`, `明細番号` |
| 取引先コード | `vendor_code`, `registration_number`, `登録番号` |
| 件名 | `desc`, `item_name`, `業務内容`, `成果物名` |
| 仕様 | `spec`, `detail`, `仕様`, `明細内容` |
| 金額 | `amount`, `金額`, `税抜金額` |
| 納期 | `due_date`, `delivery_date`, `納期`, `納品日` |

必須バリデーション:

- `desc`（業務内容）必須
- `vendorCode`（登録番号）必須
- `dueDate`（日付形式）必須

### 7-3. publishing_bulk 固定ヘッダ（順序一致必須）

`src/orders/csvImport.ts` の `PUBLISHING_BULK_FIXED_HEADERS` 準拠:

1. 担当者ID
2. 発注日
3. 支払日
4. コード
5. 支払先（ペンネーム）
6. 書籍名
7. 業務概要
8. 業務詳細（仕様）
9. 単価（税込）
10. 数量
11. 発注金額（税別）
12. 初校締切
13. 再校締切
14. 校了予定
15. 備考

行バリデーション（主なもの）:

- `担当者ID`: SlackユーザーID形式（`U...`）
- `発注日` / `支払日` / `初校締切`: 日付必須
- `コード`: 英数字/ハイフン/アンダースコア
- `数量` / `単価（税込）` / `発注金額（税別）`: 1以上整数

### 7-4. CSV取込後の保存フロー

1. Backlog課題キー単位で `LegalRequest` を `upsert`
2. 明細JSONを `OrderItem` に `upsert`（`legalRequestId + itemNo`）
3. planningモードでは `data/order-import-context/<issueKey>.json` に文脈保存
4. Backlogに取込結果コメントを追記

## 8. 運用補足（実装と揃えるための注意）

- Backlogは「ステータス管理 + 最小補足欄」が基本設計
- 明細・計算結果・文書下書きはDB正本で保持
- 期限管理の運用判断はBacklog側（課題期限/カスタム日付）を優先
- 納品/計算の後続課題は、親課題キー参照を必須運用にする
