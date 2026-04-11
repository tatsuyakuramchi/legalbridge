# GCP Staging Template

## Purpose

`staging` 環境を本番と混ぜずに立ち上げるための、ファイル名とサービス名の雛形をまとめる。

## Recommended File Names

- `cloudrun.gateway.staging.env.yaml`
- `cloudrun.gateway.staging.secrets.yaml`
- `cloudrun.work.staging.env.yaml`
- `cloudrun.work.staging.secrets.yaml`

それぞれの例は次を起点にする。

- `cloudrun.gateway.staging.env.example.yaml`
- `cloudrun.gateway.staging.secrets.example.yaml`
- `cloudrun.work.staging.env.example.yaml`
- `cloudrun.work.staging.secrets.example.yaml`

このリポジトリには、同名の `*.staging.env.yaml` と `*.staging.secrets.yaml` もプレースホルダ付きで追加済みです。
そのまま上書きして使ってよく、値を入れ終わるまではデプロイしない前提で扱います。

## Recommended Resource Names

- GCP project
  - `your-gcp-staging-project-id`
- command-service
  - `legalbridge-command-service-staging`
- work-service
  - `legalbridge-work-service-staging`
- Cloud Tasks queue
  - `legalbridge-work-items-staging`
- Scheduler jobs
  - `legalbridge-daily-scheduler-staging`
  - `legalbridge-backlog-poller-staging`
- Service accounts
  - `legalbridge-command-sa@<project>.iam.gserviceaccount.com`
  - `legalbridge-work-sa@<project>.iam.gserviceaccount.com`

## Bootstrap Flow

```powershell
.\scripts\bootstrap-gcp-staging.ps1 `
  -ProjectId your-gcp-staging-project-id `
  -CommandServiceAccountEmail legalbridge-command-sa@your-gcp-staging-project-id.iam.gserviceaccount.com `
  -WorkServiceAccountEmail legalbridge-work-sa@your-gcp-staging-project-id.iam.gserviceaccount.com `
  -WorkServiceUrl https://legalbridge-work-service-staging-xxxxx-an.a.run.app `
  -WorkServiceToken YOUR_STAGING_WORK_SERVICE_TOKEN
```

## Before Running

- `*.staging.env.yaml` と `*.staging.secrets.yaml` を example から複製して値を埋める
- `WORK_SERVICE_TOKEN` を gateway / work-service / Scheduler で同じ値にそろえる
- `WORK_SERVICE_URL` を gateway 側 env に入れる
- `DATABASE_URL` を staging 用 DB に向ける
- `GCP_PROJECT_ID` と `GCP_TASKS_QUEUE` を staging 値にする

## Validation Before Bootstrap

プレースホルダが残っていないかは次で確認できる。

```powershell
npm run staging:validate
```

`bootstrap-gcp-staging.ps1` の先頭でも同じ検証を実行するため、ダミー値が残っている状態ではそのまま止まる。

## Validation After Deploy

- `command-service /health` が 200
- `work-service /health` が 200
- `POST /jobs/scheduler` が token 付きで成功
- Backlog webhook から task が queue に積まれる
- 同じ work item を再送しても `skipped` になる
