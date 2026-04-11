# GCP Cloud Tasks Notes

## Purpose

`command-service` から `work-service` への処理移譲を、直接 HTTP 呼び出しではなく Cloud Tasks 経由で行うための補足メモ。

## Queue Mode

`command-service` 側で次を設定する。

- `WORK_QUEUE_MODE=gcp-tasks`
- `WORK_SERVICE_URL=https://...run.app`
- `GCP_PROJECT_ID=...`
- `GCP_TASKS_LOCATION=asia-northeast1`
- `GCP_TASKS_QUEUE=legalbridge-work-items`

## Authentication Model

現状の `work-service` は Cloud Run の公開制御ではなく、アプリケーション側の Bearer token で保護する。

理由:

- Cloud Tasks
- Cloud Scheduler
- 手動疎通確認

のすべてを同じ `WORK_SERVICE_TOKEN` で揃えやすくするため。

そのため現時点の推奨は次のとおり。

- `work-service` は `--allow-unauthenticated`
- アプリ側で `WORK_SERVICE_TOKEN` を検証
- command-service は Cloud Tasks 作成時に `Authorization: Bearer ...` を付与

## Required Secrets

- `WORK_SERVICE_TOKEN`
- `BACKLOG_API_KEY`
- `SLACK_BOT_TOKEN`
- `DATABASE_URL`

## Required GCP Setup

- Cloud Tasks API 有効化
- 対象 queue の作成
- command-service の実行環境が Cloud Tasks API を呼べること

## Queue Creation Example

```powershell
gcloud tasks queues create legalbridge-work-items `
  --location asia-northeast1
```

## Recommended Rollout

1. `WORK_QUEUE_MODE=inline` で境界追加後の動作確認
2. `WORK_QUEUE_MODE=http` で worker 分離確認
3. `WORK_QUEUE_MODE=gcp-tasks` で queue 経由へ切り替え

## Operational Note

Cloud Tasks 本実装は「enqueue の入口」まで追加済みであり、今後は retry policy、dead-letter、冪等性キーの運用整備を加える想定。
