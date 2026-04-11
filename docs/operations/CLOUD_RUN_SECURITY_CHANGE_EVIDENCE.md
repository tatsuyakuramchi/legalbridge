# Cloud Run Security Change Evidence

## 目的

管理者要請に基づき、Slack 受付用 Cloud Run サービスについて次の構成変更を実施したことを示す証憑を整理する。

- DDoS 等による想定外課金を抑えるため、最大インスタンス数を必要最小限に制限する
- `SLACK_SIGNING_SECRET` などの機密情報をコード直書きせず、Secret Manager 経由で安全に管理する

作成日: 2026-04-07
対象サービス: `legalbridge-slack-gateway`
対象プロジェクト: `legalbridge-488506`

## 変更内容

### 1. 最大インスタンス数の制限

[deploy-cloudrun.ps1](C:/Users/tatsuya.kuramochi/Desktop/legalbridge-proto/scripts/deploy-cloudrun.ps1) に `-MaxInstances` パラメータを追加し、Cloud Run デプロイ時に `--max-instances` を指定する構成へ変更した。

既定値:

- `3`

根拠コード:

- [deploy-cloudrun.ps1](C:/Users/tatsuya.kuramochi/Desktop/legalbridge-proto/scripts/deploy-cloudrun.ps1)

確認ポイント:

- Cloud Run リビジョン設定に `max instances = 3`

### 2. Secret Manager による機密情報管理

Cloud Run 用設定を、非機密設定と機密設定に分離した。

非機密設定:

- [cloudrun.gateway.env.example.yaml](C:/Users/tatsuya.kuramochi/Desktop/legalbridge-proto/cloudrun.gateway.env.example.yaml)
- [cloudrun.gateway.env.yaml](C:/Users/tatsuya.kuramochi/Desktop/legalbridge-proto/cloudrun.gateway.env.yaml)

機密設定:

- [cloudrun.gateway.secrets.example.yaml](C:/Users/tatsuya.kuramochi/Desktop/legalbridge-proto/cloudrun.gateway.secrets.example.yaml)
- [cloudrun.gateway.secrets.yaml](C:/Users/tatsuya.kuramochi/Desktop/legalbridge-proto/cloudrun.gateway.secrets.yaml)

デプロイスクリプトでは、機密設定ファイルを読み込んで Secret Manager に登録し、Cloud Run へは `--set-secrets` で注入する。

対象機密値:

- `SLACK_BOT_TOKEN`
- `SLACK_SIGNING_SECRET`
- `BACKLOG_API_KEY`
- `DATABASE_URL` 任意

根拠コード:

- [deploy-cloudrun.ps1](C:/Users/tatsuya.kuramochi/Desktop/legalbridge-proto/scripts/deploy-cloudrun.ps1)
- [cloudrun.gateway.secrets.example.yaml](C:/Users/tatsuya.kuramochi/Desktop/legalbridge-proto/cloudrun.gateway.secrets.example.yaml)
- [cloudrun.gateway.env.example.yaml](C:/Users/tatsuya.kuramochi/Desktop/legalbridge-proto/cloudrun.gateway.env.example.yaml)

### 3. 機密ファイルの Git 除外

[.gitignore](C:/Users/tatsuya.kuramochi/Desktop/legalbridge-proto/.gitignore) に次を追加済み。

- `cloudrun.gateway.secrets.yaml`

## 関連手順書

- [CLOUD_RUN_SECURITY_SETUP.md](C:/Users/tatsuya.kuramochi/Desktop/legalbridge-proto/docs/operations/CLOUD_RUN_SECURITY_SETUP.md)
- [SLACK_SIGNATURE_VERIFICATION_REPORT.md](C:/Users/tatsuya.kuramochi/Desktop/legalbridge-proto/docs/operations/SLACK_SIGNATURE_VERIFICATION_REPORT.md)

## 提出時に添付するとよいもの

次の 3 点を提出すると説明しやすい。

1. 本ファイル
2. [CLOUD_RUN_SECURITY_SETUP.md](C:/Users/tatsuya.kuramochi/Desktop/legalbridge-proto/docs/operations/CLOUD_RUN_SECURITY_SETUP.md)
3. [SLACK_SIGNATURE_VERIFICATION_REPORT.md](C:/Users/tatsuya.kuramochi/Desktop/legalbridge-proto/docs/operations/SLACK_SIGNATURE_VERIFICATION_REPORT.md)

## 現時点の補足

コードベース上の構成変更に加え、GCP 実環境への再反映も完了した。

## 実環境反映結果

反映日: 2026-04-07
Cloud Run Service URL: `https://legalbridge-slack-gateway-988056987352.asia-northeast1.run.app`
最新リビジョン: `legalbridge-slack-gateway-00005-ll7`

### 1. 最大インスタンス数

Cloud Run Revision の実値確認結果:

- `autoscaling.knative.dev/maxScale: '3'`

根拠:

- `gcloud run revisions describe legalbridge-slack-gateway-00005-ll7 --region asia-northeast1 --project legalbridge-488506 --format yaml`

### 2. Secret Manager 参照

Cloud Run Revision の実値確認結果:

- `BACKLOG_API_KEY`
  - `valueFrom.secretKeyRef.name: BACKLOG_API_KEY`
  - `valueFrom.secretKeyRef.key: latest`
- `SLACK_SIGNING_SECRET`
  - `valueFrom.secretKeyRef.name: SLACK_SIGNING_SECRET`
  - `valueFrom.secretKeyRef.key: latest`
- `SLACK_BOT_TOKEN`
  - `valueFrom.secretKeyRef.name: SLACK_BOT_TOKEN`
  - `valueFrom.secretKeyRef.key: latest`

根拠:

- `gcloud run services describe legalbridge-slack-gateway --region asia-northeast1 --project legalbridge-488506 --format yaml`
- `gcloud run revisions describe legalbridge-slack-gateway-00005-ll7 --region asia-northeast1 --project legalbridge-488506 --format yaml`

### 3. Secret Manager の作成済みシークレット

実環境に次のシークレットが存在することを確認済み。

- `BACKLOG_API_KEY`
- `SLACK_BOT_TOKEN`
- `SLACK_SIGNING_SECRET`

根拠:

- `gcloud secrets list --project legalbridge-488506 --format yaml`

### 4. Cloud Run 実行サービスアカウント権限

Cloud Run が Secret Manager を参照できるよう、実行サービスアカウントへ次の権限を付与済み。

- サービスアカウント: `988056987352-compute@developer.gserviceaccount.com`
- ロール: `roles/secretmanager.secretAccessor`

## 判定

管理者要請の 2 点について、実環境上も次を満たす状態になっている。

- Cloud Run の最大インスタンス数は `3` に制限済み
- `SLACK_SIGNING_SECRET` などの機密値は Secret Manager 参照へ移行済み
