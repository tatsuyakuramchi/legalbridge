# Cloud Run Security Setup

## 目的

Slack 受付用 Cloud Run サービス `legalbridge-slack-gateway` を本番公開する際に、想定外課金と機密情報漏えいのリスクを抑える。

## 対応方針

- `最大インスタンス数` を必要最小限に制限する
- `SLACK_SIGNING_SECRET` などの機密値は Secret Manager で管理する

## 最大インスタンス数

推奨値:

- `3`

一時的に余裕を見たい場合:

- `5`

本リポジトリの Cloud Run デプロイスクリプト [deploy-cloudrun.ps1](C:/Users/tatsuya.kuramochi/Desktop/legalbridge-proto/scripts/deploy-cloudrun.ps1) は、`-MaxInstances` で上限を指定できる。

実行例:

```powershell
.\scripts\deploy-cloudrun.ps1 -ProjectId legalbridge-488506 -MaxInstances 3
```

## Secret Manager 運用

非機密設定:

- [cloudrun.gateway.env.example.yaml](C:/Users/tatsuya.kuramochi/Desktop/legalbridge-proto/cloudrun.gateway.env.example.yaml)

機密設定:

- [cloudrun.gateway.secrets.example.yaml](C:/Users/tatsuya.kuramochi/Desktop/legalbridge-proto/cloudrun.gateway.secrets.example.yaml)

デプロイスクリプトは次を行う。

1. `cloudrun.gateway.secrets.yaml` の機密値を Secret Manager に登録または追加
2. Cloud Run デプロイ時に `--set-secrets` で各環境変数へ注入

対象の機密値:

- `SLACK_BOT_TOKEN`
- `SLACK_SIGNING_SECRET`
- `BACKLOG_API_KEY`
- `DATABASE_URL` 任意

## 画面操作で確認する項目

Cloud Run のサービス詳細画面で次を確認する。

- `セキュリティ` タブで `公開アクセスを許可する` が用途どおり有効
- `リビジョン` または `新しいリビジョンの編集とデプロイ` で最大インスタンス数が `3` または `5`
- `変数とシークレット` で機密値が Secret Manager 参照になっている

## 備考

Slack 受付サービスは公開エンドポイントだが、アプリ側では [SLACK_SIGNATURE_VERIFICATION_REPORT.md](C:/Users/tatsuya.kuramochi/Desktop/legalbridge-proto/docs/operations/SLACK_SIGNATURE_VERIFICATION_REPORT.md) のとおり署名検証を実装・テスト済みである。
