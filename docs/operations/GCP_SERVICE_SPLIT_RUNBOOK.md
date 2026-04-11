# GCP Service Split Runbook

## Purpose

LegalBridge を GCP 上で `command-service` と `work-service` の 2 サービス構成で運用するための実行手順をまとめる。

この runbook は次を対象とする。

- `command-service` のデプロイ
- `work-service` のデプロイ
- `WORK_QUEUE_MODE=http` の有効化
- `Cloud Scheduler` からの定期ジョブ起動

## Target Topology

- `command-service`
  - 公開 Cloud Run
  - Slack slash command / interactions
  - Backlog webhook
  - 軽量な受付処理
- `work-service`
  - 非公開 Cloud Run
  - 文書生成
  - Drive 保存
  - ロイヤリティ計算
  - scheduler / poller 実行
- `Cloud Scheduler`
  - `work-service` の `/jobs/scheduler`
  - `work-service` の `/jobs/backlog-poller`

## Required Files

### command-service

- `cloudrun.gateway.env.yaml`
- `cloudrun.gateway.secrets.yaml`

### work-service

- `cloudrun.work.env.yaml`
- `cloudrun.work.secrets.yaml`

## Required Environment / Secret Contract

### command-service env

- `WORK_QUEUE_MODE=http`
- `WORK_SERVICE_URL=https://...run.app`

### command-service secrets

- `WORK_SERVICE_TOKEN`

### work-service secrets

- `WORK_SERVICE_TOKEN`
- `SLACK_BOT_TOKEN`
- `BACKLOG_API_KEY`
- `DATABASE_URL`

補足:

- `WORK_SERVICE_TOKEN` は command-service と work-service で同じ値を使う
- work-service 側では Bearer token 認証として扱う

## Deploy Order

1. `work-service` を先にデプロイする
2. `work-service` の URL を確認する
3. `command-service` に `WORK_SERVICE_URL` を設定する
4. `command-service` の `WORK_QUEUE_MODE=http` を有効化する
5. Cloud Scheduler を設定する

## Deploy Commands

### 1. work-service

```powershell
.\scripts\deploy-workservice.ps1 -ProjectId YOUR_PROJECT_ID -MaxInstances 3
```

### 2. command-service

```powershell
.\scripts\deploy-cloudrun.ps1 -ProjectId YOUR_PROJECT_ID -MaxInstances 3
```

## Recommended Validation

### work-service health

```powershell
curl https://YOUR_WORK_SERVICE_URL/health
```

### work-service authorized scheduler trigger

```powershell
curl -X POST `
  -H "Authorization: Bearer YOUR_WORK_SERVICE_TOKEN" `
  https://YOUR_WORK_SERVICE_URL/jobs/scheduler
```

### command-service queue mode

確認ポイント:

- `WORK_QUEUE_MODE=http`
- `WORK_SERVICE_URL` が設定されている
- `WORK_SERVICE_TOKEN` が Secret Manager から注入されている

## Cloud Scheduler Targets

### Daily scheduler job

- Method: `POST`
- URL: `https://YOUR_WORK_SERVICE_URL/jobs/scheduler`
- Auth header: `Authorization: Bearer YOUR_WORK_SERVICE_TOKEN`
- Recommended cadence: once per day

### Backlog poller job

- Method: `POST`
- URL: `https://YOUR_WORK_SERVICE_URL/jobs/backlog-poller`
- Auth header: `Authorization: Bearer YOUR_WORK_SERVICE_TOKEN`
- Recommended cadence: operationally tuned

注意:

- poller は webhook で代替可能な範囲を見直し、必要最小限で運用する
- 高頻度運用をする場合は Backlog API 制限と重複実行に注意する

## Failure Handling

### command-service failure

- Slack / Backlog 受付異常として表面化する
- `/health` と `/ready` を確認する
- `WORK_SERVICE_URL` 設定漏れや token 不一致を疑う

### work-service failure

- 文書生成や定期ジョブが失敗する
- Cloud Logging 上で `/work-items` または `/jobs/*` の失敗を確認する
- Drive 認証、DB 接続、Backlog API、WeasyPrint 依存を確認する

### token mismatch

- command-service からの `http` enqueue が 401 になる
- Cloud Scheduler からの job 実行も 401 になる
- 両サービスの `WORK_SERVICE_TOKEN` を同じ値にそろえる

## Current Operational Modes

### Safe migration mode

- `WORK_QUEUE_MODE=inline`
- 既存挙動を維持
- worker 単体デプロイの確認に向く

### Split execution mode

- `WORK_QUEUE_MODE=http`
- `work-service` へ処理移譲
- 2 サービス構成の本番候補

## Next Hardening Steps

- Cloud Tasks への本実装移行
- Cloud Scheduler ジョブ作成の自動化
- command-service / work-service の個別監視整備
- 冪等性キーと再試行時の重複生成防止
