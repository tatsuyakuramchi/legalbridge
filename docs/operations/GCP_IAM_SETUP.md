# GCP IAM Setup

## Purpose

`command-service` と `work-service` を同じデフォルト権限で動かさず、役割ごとにサービスアカウントを分けるための手順メモ。

## Recommended Split

- `legalbridge-command-sa`
  - `command-service` 用
  - Cloud Tasks enqueue
  - Secret Manager 参照
- `legalbridge-work-sa`
  - `work-service` 用
  - Secret Manager 参照
  - Cloud SQL 接続
- `legalbridge-scheduler-sa`
  - 補助用
  - Scheduler や将来の OIDC 呼び出しへ広げる場合の受け皿

## Bootstrap Script

次のスクリプトでサービスアカウント作成と基本ロール付与をまとめて実行できる。

```powershell
.\scripts\setup-gcp-service-accounts.ps1 `
  -ProjectId your-gcp-project-id
```

## Roles Applied by the Script

- `legalbridge-command-sa`
  - `roles/secretmanager.secretAccessor`
  - `roles/cloudtasks.enqueuer`
- `legalbridge-work-sa`
  - `roles/secretmanager.secretAccessor`
  - `roles/cloudsql.client`
- `legalbridge-scheduler-sa`
  - `roles/secretmanager.secretAccessor`
- Cloud Tasks service agent
  - `roles/run.invoker`

## Deploy Usage

作成したサービスアカウントは deploy 時に明示して固定する。

```powershell
.\scripts\deploy-commandservice.ps1 `
  -ProjectId your-gcp-project-id `
  -ServiceAccountEmail legalbridge-command-sa@your-gcp-project-id.iam.gserviceaccount.com

.\scripts\deploy-workservice.ps1 `
  -ProjectId your-gcp-project-id `
  -ServiceAccountEmail legalbridge-work-sa@your-gcp-project-id.iam.gserviceaccount.com
```

## Notes

- 現行の `work-service` は Bearer token 保護を前提にしているため、Cloud Run 自体は公開設定でも動かせる。
- 将来 `work-service` を非公開化して OIDC 呼び出しに寄せる場合は、Cloud Scheduler 側にも専用サービスアカウントと `run.invoker` の見直しを入れる。
- Cloud SQL の認証方式を IAM DB 認証に寄せる場合は、`work-service` 側の権限を別途見直す。
