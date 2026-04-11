# Docs Index

`docs` フォルダ内の資料を、`利用者向け` `運用者向け` `開発者向け` の 3 区分に整理しています。

## フォルダ構成

- `user/`
  - 利用者向けマニュアル
- `operations/`
  - 初期設定、運用、確認手順
- `development/`
  - 実装方針、仕様、マッピング資料

## 利用者向け

- `user/BUSINESS_SLASH_COMMAND_MANUAL.md`
  - 事業部向けの Slack スラッシュコマンドと申請方法のマニュアル

## 運用者向け

- `operations/DB_SETUP.md`
  - ローカル DB のセットアップ手順
- `operations/BACKLOG_SETUP_CHECKLIST.md`
  - Backlog 側の初期設定チェックリスト
- `operations/OPERATION_READINESS_CHECKLIST.md`
  - ローカル UI / Backlog / Slack の運用前確認チェックリスト
- `operations/SLACK_SIGNATURE_VERIFICATION_REPORT.md`
  - Slack 署名検証の実装内容とテスト結果の提出用レポート
- `operations/CLOUD_RUN_SECURITY_SETUP.md`
  - Cloud Run の最大インスタンス数制限と Secret Manager 運用手順
- `operations/CLOUD_RUN_SECURITY_CHANGE_EVIDENCE.md`
  - Cloud Run のセキュリティ構成変更に関する提出用証憑
- `operations/ARCHITECTURE_V2_OPERATIONS.md`
  - 新アーキテクチャの運用境界、障害切り分け、移行手順
- `operations/GCP_SERVICE_SPLIT_RUNBOOK.md`
  - `command-service / work-service` の役割分担と段階移行の運用手順
- `operations/GCP_DEPLOY_SEQUENCE.md`
  - GCP 2サービス構成のデプロイ順序
- `operations/GCP_CLOUD_TASKS_NOTES.md`
  - `WORK_QUEUE_MODE=gcp-tasks` の設定と認証方式のメモ
- `operations/GCP_IAM_SETUP.md`
  - GCP 2サービス構成で使うサービスアカウントとロール付与の基準
- `operations/GCP_RETRY_AND_IDEMPOTENCY.md`
  - Cloud Tasks の retry 方針と work item 冪等性の考え方
- `operations/GCP_STAGING_TEMPLATE.md`
  - staging 用の env / secrets / サービス名の雛形
- `operations/GCP_TWO_SERVICE_SUPPLEMENT.md`
  - 既存のローカル一体運用資料を 2サービス構成でどう読み替えるかの補足

## 開発者向け

- `development/ARCHITECTURE_V2.md`
  - Slack / Backlog / Local / DB の新アーキテクチャ全体図と責務分離
- `development/GCP_TARGET_ARCHITECTURE.md`
  - GCP 向け `command-service / work-service / shared` 再設計の基準資料
- `development/DATA_ALLOCATION_POLICY.md`
  - Slack / Backlog / DB / アプリの責務整理
- `development/UI_PRIMARY_DOCUMENT_WORKFLOW.md`
  - `Backlog -> UI / DB -> Drive` を前提にした文書作成フロー
- `development/LICENSE_WORKFLOW_DESIGN.md`
  - ライセンス契約と個別利用許諾条件の導線設計
- `development/SLACK_WORKFLOW_FIELDS.md`
  - Slack 申請フォームで扱う項目定義
- `development/SLACK_TO_BACKLOG_MAPPING.md`
  - Slack 入力値と Backlog / DB の対応整理
- `development/SLACK_MODAL_FIELD_INVENTORY.md`
  - Slack モーダル項目の棚卸し表。`残す / Backlog に寄せる / 廃止候補` を整理
- `development/SLACK_MODAL_MINIMUM_FIELDS_FINAL.md`
  - Slack モーダルの確定版最小項目一覧。種別ごとに Slack に残す項目と Backlog 補完項目を整理
- `development/BACKLOG_FIELD_MAPPING_GUIDE.md`
  - Backlog カスタム属性と `.env` の対応整理
- `development/BACKLOG_CUSTOM_FIELD_API_SPEC.md`
  - 出版発注書 / 納品リクエスト / 利用許諾料計算の Backlog カスタム属性追加仕様
- `development/PLANNING_ORDER_TEMPLATE_VARIABLES.md`
  - 企画発注書テンプレートの変数一覧と、出版一括発注書へ流用する差し替え候補
- `development/PUBLISHING_ORDER_BACKLOG_DESIGN.md`
  - 出版発注書の親子課題構造、1明細1課題、期日正本ルール、検収書一括作成の設計
- `development/ADMIN_UI_REDESIGN_WIREFRAME.md`
  - 管理UIを機能別から業務フロー別へ組み替えるための画面遷移図とワイヤーフレーム

## 整理方針

次のような資料は削除済みです。

- 役目を終えた移行計画
- 検討途中の差分メモ
- 現行マニュアルと重複する古い利用者向けガイド

## GCP 2サービス構成を先に追う場合

GCP へ再設計した構成を追う場合は、次の順で読むと全体像をつかみやすくなります。

1. `development/GCP_TARGET_ARCHITECTURE.md`
2. `operations/GCP_SERVICE_SPLIT_RUNBOOK.md`
3. `operations/GCP_DEPLOY_SEQUENCE.md`
4. `operations/GCP_IAM_SETUP.md`
5. `operations/GCP_CLOUD_TASKS_NOTES.md`
6. `operations/GCP_RETRY_AND_IDEMPOTENCY.md`
7. `operations/GCP_STAGING_TEMPLATE.md`
