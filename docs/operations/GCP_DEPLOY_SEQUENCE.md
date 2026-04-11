# GCP Deploy Sequence

## Purpose

2 サービス構成を最小の手順で立ち上げるときの順番をまとめる。

## Recommended Order

1. Secret Manager 用の値を用意する
2. サービスアカウントを作成して IAM ロールを付与する
3. Cloud Tasks queue を作成する
4. `work-service` をデプロイする
5. `work-service` URL を `command-service` 側へ設定する
6. `command-service` をデプロイする
7. Cloud Scheduler を登録する
8. `WORK_QUEUE_MODE` を `inline` から `http`、必要に応じて `gcp-tasks` に上げる

## Commands

### 1. IAM bootstrap

```powershell
.\scripts\setup-gcp-service-accounts.ps1 -ProjectId YOUR_PROJECT_ID
```

### 2. Cloud Tasks queue

```powershell
.\scripts\create-work-queue.ps1 -ProjectId YOUR_PROJECT_ID
```

### 3. work-service

```powershell
.\scripts\deploy-workservice.ps1 `
  -ProjectId YOUR_PROJECT_ID `
  -MaxInstances 3 `
  -ServiceAccountEmail legalbridge-work-sa@YOUR_PROJECT_ID.iam.gserviceaccount.com
```

### 4. command-service

```powershell
.\scripts\deploy-commandservice.ps1 `
  -ProjectId YOUR_PROJECT_ID `
  -MaxInstances 3 `
  -ServiceAccountEmail legalbridge-command-sa@YOUR_PROJECT_ID.iam.gserviceaccount.com
```

### 5. Cloud Scheduler

```powershell
.\scripts\register-work-scheduler-jobs.ps1 `
  -ProjectId YOUR_PROJECT_ID `
  -WorkServiceUrl https://YOUR_WORK_SERVICE_URL `
  -WorkServiceToken YOUR_WORK_SERVICE_TOKEN
```

## Rollout Modes

### Mode A

- `WORK_QUEUE_MODE=inline`
- まずサービス分割だけ確認したいとき

### Mode B

- `WORK_QUEUE_MODE=http`
- worker への直接委譲を確認したいとき

### Mode C

- `WORK_QUEUE_MODE=gcp-tasks`
- queue を挟んだ本番候補構成

## Validation Checklist

- `work-service /health` が 200
- `command-service /health` が 200
- `POST /jobs/scheduler` が token 付きで成功
- queue 作成済み
- `WORK_SERVICE_TOKEN` が両サービスで一致
- `WORK_SERVICE_URL` が command-service に設定済み
