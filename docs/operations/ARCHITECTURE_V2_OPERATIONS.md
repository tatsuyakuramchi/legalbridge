# Architecture V2 Operations

## 目的

新アーキテクチャを保守運用できる状態で固定する。

対象:

- Slack-Backlog 受付サービス
- Backlog
- Local UI / Worker
- DB
- Drive

## 運用境界

- `Slack <-> Backlog`
  - 受付主線
  - Local / DB 障害時でも継続を優先
- `Backlog <-> Local`
  - 文書生成、再処理、再計算の補助主線
- `Local <-> DB`
  - 下書き、マスタ、履歴、生成済み文書メタデータ

## 障害切り分け

### 1. Slack から起票できない

確認順:

1. Slack App の Slash Command / Interactivity 設定
2. 受付サービスの稼働状態
3. gateway の `/status` または `/ready`
4. `npm run gateway:check`
5. Backlog API キーとプロジェクト設定
6. Backlog 課題タイプ / カスタム属性の整合性

このケースでは Local / DB を先に疑わない。

### 2. Backlog には起票できるが文書生成されない

確認順:

1. Backlog Webhook または Polling の動作
2. Local Worker の稼働状態
3. Drive 認証
4. DB の接続状態

このケースでは Slack は通知の有無だけ確認すればよい。

### 3. 文書生成はされるが Slack 通知されない

確認順:

1. `SLACK_BOT_TOKEN`
2. 通知先チャンネル設定
3. Slack API エラー

このケースは主線障害ではなく補助障害として扱う。

### 4. 期限通知が出ない

確認順:

1. Backlog 課題の期限日
2. Backlog 支払期日 / 報告期限カスタム属性
3. Local Scheduler の稼働状態
4. Slack 通知設定

## 属性変更時の運用

- Backlog 側で課題タイプやカスタム属性を変更するときは、先に `BACKLOG_FIELD_*` と対応コードを確認する
- Slack モーダル項目を変更するときは、同時に Backlog マッピングを更新する
- アプリ起動時の Backlog 設定差分警告を確認する
- gateway は重大差分があると起動を停止するため、公開受付を再開する前に blocking issue を解消する
- `GATEWAY_STATUS_OUTPUT_PATH` を指定すると `npm run gateway:check` の結果を JSON ファイルとして保存できる
- 変更後は `Slash Command -> Modal -> Backlog起票` をテストする
- 変更後は `Backlog -> Local -> 文書生成` をテストする

## 移行手順

### フェーズ 1

- Slack 受付を `Slack-Backlog 受付サービス` に集約
- Local / DB を起票主線から外す

### フェーズ 2

- Backlog を案件ヘッダ、ステータス、期限の正本にする
- Local は Backlog 課題キー起点で再処理できるようにする

### フェーズ 3

- Slack 通知を任意化する
- Slack 障害時も `Backlog -> Local` が継続することを確認する

### フェーズ 4

- DB にしかない業務継続必須値を棚卸しする
- 必要なら Backlog カスタム属性へ移す

## リリース確認

- `/法務依頼` で新規起票できる
- Backlog コメント追記ができる
- Backlog 課題キー指定で Local UI を開ける
- 文書生成が Backlog 課題だけで再実行できる
- Slack 未設定でも build / webhook / document generation が継続する
- 納品期日、報告期限、支払期日が Backlog で確認できる

## CI / デプロイ前確認

- GitHub Actions の `CI` で `npm run build` を常時実行する
- 必要な secrets / vars が揃う環境では `npm run gateway:check` を実行する
- `gateway:check` は blocking issue があると終了コード 1 を返す
- `GATEWAY_STATUS_OUTPUT_PATH` を指定すると、確認結果を JSON artifact として保存できる

## 監視の考え方

- 受付主線
  - Slack 受付サービスの死活
  - Backlog API エラー率
- 補助主線
  - Local Worker の死活
  - Drive アップロード失敗
  - DB 接続エラー
- 任意通知
  - Slack 通知失敗

通知失敗は業務停止として扱わず、補助障害として記録する。
