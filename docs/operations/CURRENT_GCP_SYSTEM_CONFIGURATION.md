# LegalBridge 現行 GCP 構成書

更新日: 2026-04-14  
対象環境: 本番相当 GCP 環境  
GCP Project: `legalbridge-488506`  
Region: `asia-northeast1`

## 1. 目的

本書は、LegalBridge の現在の稼働構成をシステム管理部署へ共有するための現況資料である。  
設計検討中の将来構成ではなく、2026-04-14 時点で実際に運用反映されている GCP 構成を記載する。

## 2. システム概要

LegalBridge は、法務依頼や発注書作成などの業務を支援するアプリケーションであり、以下を中核に動作している。

- Backlog
  - ステータス管理
  - 任意の補足情報保持
- Cloud Run
  - Slack 受付、作業実行、管理 UI の公開
- Cloud SQL for PostgreSQL
  - マスタ、業務補助データ、生成履歴、同期履歴の保持
- Secret Manager
  - 外部連携資格情報の保管
- Cloud Tasks / Cloud Scheduler
  - 非同期実行および定期ジョブ実行

ローカル常駐前提の運用は廃止し、現在は GCP 上の Cloud Run 中心で稼働している。

## 3. 現行構成

### 3.1 GCP リソース一覧

| 区分 | 名称 | 用途 |
|------|------|------|
| Cloud Run | `legalbridge-slack-gateway` | Slack / Backlog 受付、軽量 API、ヘルスチェック |
| Cloud Run | `legalbridge-work-service` | 文書生成、同期処理、定期ジョブ実行 |
| Cloud Run | `legalbridge-admin-ui` | 管理 UI、CSV 一括発注、運用確認 |
| Cloud SQL for PostgreSQL | `legalbridge-db` | 業務データ永続化 |
| DB 名 | `legalbridge` | Prisma で利用するアプリケーション DB |
| Cloud Tasks Queue | `legalbridge-work-items` | 非同期 work item 実行 |
| Cloud Scheduler | `legalbridge-daily-scheduler` | 日次定期処理 |
| Cloud Scheduler | `legalbridge-backlog-poller` | Backlog 補助同期ジョブ |
| Artifact Registry | `legalbridge` | Cloud Run 用コンテナイメージ格納 |
| Secret Manager | 複数 | 外部連携 secret 保管 |

### 3.2 サービスアカウント

| 名称 | 用途 |
|------|------|
| `legalbridge-command-sa@legalbridge-488506.iam.gserviceaccount.com` | gateway 系 Cloud Run 用 |
| `legalbridge-work-sa@legalbridge-488506.iam.gserviceaccount.com` | work-service / admin-ui 用 |
| `legalbridge-scheduler-sa@legalbridge-488506.iam.gserviceaccount.com` | Scheduler / 補助ジョブ用 |

## 4. 各 Cloud Run サービスの役割

### 4.1 `legalbridge-slack-gateway`

役割:

- Slack 受付エンドポイント
- Backlog 設定整合性チェック
- 軽量なヘルスチェック API
- 必要に応じて `work-service` へ処理委譲

主な公開パス:

- `/health`
- `/ready`
- `/status`
- `/slack/commands`
- `/slack/interactions`

補足:

- 現行運用では Slack / Backlog 受付の入口である
- `WORK_QUEUE_MODE=http` で `work-service` に委譲する構成

### 4.2 `legalbridge-work-service`

役割:

- Backlog 補助同期
- 定期ジョブ実行
- 文書生成処理
- Drive 連携処理
- バックグラウンド系 API

主な公開パス:

- `/health`
- `/jobs/scheduler`
- `/jobs/backlog-poller`

補足:

- Scheduler から token 付きで呼び出される
- gateway からの内部処理委譲先でもある

### 4.3 `legalbridge-admin-ui`

役割:

- 管理 UI 提供
- マスタ管理
- CSV / Excel 一括発注管理
- Backlog 手動同期
- 運用状態の可視化

主な公開パス:

- `/admin`
- `/admin/orders/csv`
- `/admin/settings/workflow`
- `/admin/masters`

補足:

- ルート `/` は画面を持たず、管理 UI は `/admin` 配下で提供

## 5. データ保存先

### 5.1 Backlog

Backlog は以下の情報に限定して使う。

- 課題タイプ
- ステータス
- 課題キー
- 期限系の最小情報
- 任意の補足情報

現行接続先:

- Space: `arclight`
- Project Key: `LEGAL`

### 5.2 Cloud SQL for PostgreSQL

Cloud SQL には以下を保持する。

- Staff / Vendor などのマスタ
- ワークフロー補助データ
- 発注関連の補助データ
- 生成文書関連メタデータ
- Backlog 同期履歴

Prisma migration は本番 DB に適用済みである。

## 6. 外部連携

### 6.1 Slack

用途:

- Slash Command 受付
- モーダル応答
- 必要な通知の送信

備考:

- Slack は受付・通知に利用しているが、案件の正本は Backlog 側に置く

### 6.2 Backlog

用途:

- 案件管理の正本
- issueType / custom field の取得
- 同期・状態確認

備考:

- Backlog 設定に不足がある場合、gateway の health に warning または blocking issue として反映される

### 6.3 Google Drive

用途:

- 生成文書の保管

認証方式:

- Secret Manager に格納したサービスアカウント JSON を Cloud Run へマウントして利用

## 7. Secret Manager 管理対象

値そのものは本書に記載しない。現行の管理対象は次の通り。

- `SLACK_BOT_TOKEN`
- `SLACK_SIGNING_SECRET`
- `BACKLOG_API_KEY`
- `DATABASE_URL`
- `WORK_SERVICE_TOKEN`
- `GOOGLE_SERVICE_ACCOUNT_KEY_JSON`

補足:

- Cloud Run には Secret Manager から注入する
- 管理 UI 用 deploy script は `__KEEP_EXISTING_SECRET__` 指定時に既存 secret を上書きしないよう修正済み

## 8. 非同期・定期実行構成

### 8.1 Cloud Tasks

- Queue 名: `legalbridge-work-items`
- 用途:
  - gateway から worker 処理へ委譲する非同期キュー

### 8.2 Cloud Scheduler

- `legalbridge-daily-scheduler`
  - 日次定期処理
- `legalbridge-backlog-poller`
  - Backlog 補助同期

補足:

- webhook を主としつつ、現時点では poller を補助運用として残している
- 将来的に webhook で完全代替できる範囲が明確になれば、poller は停止候補となる

## 9. 現行の運用上の見る場所

### 9.1 ヘルスチェック

- gateway: `/health`
- work-service: `/health`
- admin-ui: `/admin`

### 9.2 主な確認対象

- Cloud Run revision の起動可否
- gateway `/health` の Backlog warning / blocking issue
- Scheduler job の有効状態
- Cloud SQL 接続可否
- Admin UI 上の Backlog 同期履歴

## 10. 既知の現状補足

- Backlog の不要カスタム属性は整理済みであり、残存属性もすべて任意扱いである
- 海外IP課題タイプ `海外IP契約（基本契約）` `海外IP契約（変更合意）` は作成済みである
- Admin UI 上の文言は GCP 運用前提へ更新済みであり、ローカル常駐前提の記述は解消方向で統一している

## 11. 変更時の影響範囲

以下を変更する場合は、Cloud Run / Backlog / DB の複数レイヤへ影響する可能性がある。

- Backlog の課題タイプ追加・名称変更
- Backlog カスタム属性追加・ID 変更
- Secret のローテーション
- Cloud SQL 接続情報変更
- Cloud Run service account 変更

変更後の最低確認:

1. `legalbridge-slack-gateway /health`
2. `legalbridge-work-service /health`
3. `legalbridge-admin-ui /admin`
4. Backlog API 接続確認
5. Admin UI の手動同期確認

## 12. Backlog 最小属性セット

2026-04-14 時点で Backlog に残している属性は次の通り。

- 共通補足
  - `相手方`
  - `希望期限`
  - `備考`
  - `文書番号`
- 契約系 / 発注系
  - `契約日・発注日`
  - `契約期間`
  - `案件名`
- 参照キー
  - `親ライセンス課題キー`
  - `許諾開始日`
  - `親課題キー`
  - `明細番号`
- 納品リクエスト
  - `納品備考`
  - `今回納品金額`
  - `納期 / 校了予定`
  - `検収日`
  - `支払予定日`
- 利用許諾料計算
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

補足:

- 上記はすべて任意項目である
- 詳細条件や帳票向け補足値は DB / 管理 UI 側で保持する

## 13. 関連資料

- [GCP Deploy Sequence](C:/Users/tatsuya.kuramochi/Desktop/legalbrigde-proto_GCP/docs/operations/GCP_DEPLOY_SEQUENCE.md)
- [GCP IAM Setup](C:/Users/tatsuya.kuramochi/Desktop/legalbrigde-proto_GCP/docs/operations/GCP_IAM_SETUP.md)
- [Architecture V2 Operations](C:/Users/tatsuya.kuramochi/Desktop/legalbrigde-proto_GCP/docs/operations/ARCHITECTURE_V2_OPERATIONS.md)
- [GCP Target Architecture](C:/Users/tatsuya.kuramochi/Desktop/legalbrigde-proto_GCP/docs/development/GCP_TARGET_ARCHITECTURE.md)
