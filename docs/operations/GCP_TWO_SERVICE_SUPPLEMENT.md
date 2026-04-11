# GCP Two-Service Supplement

## Purpose

既存の運用 docs が `Local UI / Worker` 前提で書かれている箇所を、GCP の 2 サービス構成で読むときの補足。

## Terminology Mapping

- 旧: `Slack-Backlog gateway`
  - 新: `command-service`
- 旧: `Local Worker`
  - 新: `work-service`
- 旧: `Local Scheduler`
  - 新: `Cloud Scheduler -> work-service /jobs/scheduler`
- 旧: `Local Poller`
  - 新: `Cloud Scheduler -> work-service /jobs/backlog-poller`

## Reading Older Docs

既存 docs に次の文言が出てきたら、読み替える。

- `Local / DB`
  - 開発用の一体起動
- `Local Worker`
  - 現在は `work-service` へ分離対象
- `Backlog -> Local -> document generation`
  - 現在は `Backlog -> command-service -> queue -> work-service`

## Current Recommended Production Shape

- command-service
  - Slack / Backlog 公開入口
- work-service
  - 非同期実行の本体
- Cloud Tasks
  - command から work への橋渡し
- Cloud Scheduler
  - 定期実行の起動元

## Migration Status

現在のコードでは次がすでに反映済み。

- queue 境界の追加
- work-service の HTTP 入口
- scheduler / poller の HTTP 起動
- Cloud Tasks enqueue
- WorkExecution による冪等性

今後の主な残作業:

- built-in dead-letter 配線
- docs の旧表現の全面置換
- 本番用の監視 / アラート整備
