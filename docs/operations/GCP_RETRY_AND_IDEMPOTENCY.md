# GCP Retry And Idempotency

## Purpose

2 サービス構成で Cloud Tasks を使うときの retry 方針と、アプリ側の冪等性方針をまとめる。

## Retry Policy

`create-work-queue.ps1` は次の retry 系パラメータを持つ。

- `MaxAttempts`
- `MinBackoffSeconds`
- `MaxBackoffSeconds`
- `MaxDoublings`
- `MaxRetryDurationSeconds`
- `MaxDispatchesPerSecond`
- `MaxConcurrentDispatches`

推奨の初期値:

- attempts: `5`
- min backoff: `10s`
- max backoff: `300s`
- max retry duration: `3600s`
- dispatches per second: `5`
- concurrent dispatches: `10`

## Dead-Letter Strategy

現時点では built-in dead-letter の自動配線までは実装していない。
その代わり、運用として次を推奨する。

- 本体 queue: `legalbridge-work-items`
- 隔離 queue: `legalbridge-work-items-dlq`

`create-work-queue.ps1 -CreateDeadLetterQueue` を使うと、隔離用 queue も同時に用意できる。

運用方針:

- 本体 queue の retry 上限超過や恒久失敗はログで検知する
- 再投入前の保留先として dlq 名称の queue を使う
- built-in dead-letter 配線は後続タスクとして扱う

## Application Idempotency

アプリ側では `WorkExecution` テーブルで冪等性を持つ。

キーの構成要素:

- work type
- issue key
- issue type
- source
- status id
- issue updated timestamp

このキーが同じ場合:

- すでに `SUCCEEDED` ならスキップ
- `RUNNING` かつ短時間ならスキップ
- それ以外は再実行

## Worker Response

`/work-items` は次を返す。

- `executed: true`
  - 実行した
- `skipped: true`
  - 冪等性によりスキップした
- `skipReason`
  - `duplicate_succeeded` または `duplicate_running`

## Operational Note

retry を強くしすぎると、同一 issue の更新ラッシュ時に queue が詰まりやすい。
最初は控えめな retry と dispatch rate から始めて、Cloud Logging を見ながら調整する。
