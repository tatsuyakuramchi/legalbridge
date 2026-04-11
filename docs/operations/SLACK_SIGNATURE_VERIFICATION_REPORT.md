# Slack Signature Verification Report

## 目的

Cloud Run などの公開 HTTPS エンドポイントで Slack の Slash Command / Interactivity を受ける際に、Slack 署名検証によるアクセス制御が実装されていること、および不正署名を拒否できることを確認した結果を記録する。

実施日: 2026-04-07
対象プロジェクト: `legalbridge-proto`

## 対象エンドポイント

- `/slack/commands`
- `/slack/interactions`

## 実装概要

Slack 受付ゲートウェイの実体は [src/gateway/app.ts](/C:/Users/tatsuya.kuramochi/Desktop/legalbridge-proto/src/gateway/app.ts) で構成しており、`ExpressReceiver` に `SLACK_SIGNING_SECRET` を渡している。互換のため [src/slackGatewayApp.ts](/C:/Users/tatsuya.kuramochi/Desktop/legalbridge-proto/src/slackGatewayApp.ts) からも同じ実装を再エクスポートしている。

この構成により、Slack から送信されたリクエストは次の情報で検証される。

- `x-slack-request-timestamp`
- `x-slack-signature`
- リクエストボディ

署名が一致しない場合、リクエストはハンドラに到達する前に拒否される。

## テスト方針

[src/tests/slackGatewaySignature.test.ts](/C:/Users/tatsuya.kuramochi/Desktop/legalbridge-proto/src/tests/slackGatewaySignature.test.ts) にて、ローカル HTTP サーバーへ擬似 Slack リクエストを送信し、次の 2 観点を検証した。

1. 不正署名のリクエストが `401` で拒否されること
2. 正常署名のリクエストが `200` で受理され、Slack コマンドハンドラまで到達すること

## 実行コマンド

```powershell
npm run build
npm run test:unit
```

## テスト結果

### 1. 不正署名リクエストの拒否

- テスト名: `Slack gateway rejects requests with invalid signature`
- 想定結果: `401 Unauthorized`
- 実測結果: `401` を返して拒否
- 補足: テスト実行ログ上でも `Slack request signing verification failed. Signature mismatch.` を確認

### 2. 正常署名リクエストの受理

- テスト名: `Slack gateway accepts requests with valid signature`
- 想定結果: `200 OK`
- 実測結果: `200` を返して受理
- 補足: テスト用 `/test` コマンドのハンドラ到達を確認

### 3. ユニットテスト全体結果

- 実行日時: 2026-04-07
- 総テスト数: `12`
- 成功: `12`
- 失敗: `0`

抜粋:

```text
# [WARN]   Request verification failed (code: slack_bolt_receiver_authenticity_error, message: Slack request signing verification failed. Signature mismatch.)
# Subtest: Slack gateway rejects requests with invalid signature
ok 11 - Slack gateway rejects requests with invalid signature
# Subtest: Slack gateway accepts requests with valid signature
ok 12 - Slack gateway accepts requests with valid signature
1..12
# tests 12
# pass 12
# fail 0
```

## 判定

Slack 受付ゲートウェイには署名検証が実装されており、少なくともユニットテストでは次を確認済みである。

- 不正署名の外部リクエストを拒否できる
- 正常署名の Slack リクエストのみ受理できる

したがって、公開エンドポイント化にあたり必要な Slack 署名検証の実装・テストは完了している。

## 関連ファイル

- [src/gateway/app.ts](/C:/Users/tatsuya.kuramochi/Desktop/legalbridge-proto/src/gateway/app.ts)
- [src/slackGatewayApp.ts](/C:/Users/tatsuya.kuramochi/Desktop/legalbridge-proto/src/slackGatewayApp.ts)
- [src/slackGateway.ts](/C:/Users/tatsuya.kuramochi/Desktop/legalbridge-proto/src/slackGateway.ts)
- [src/tests/slackGatewaySignature.test.ts](/C:/Users/tatsuya.kuramochi/Desktop/legalbridge-proto/src/tests/slackGatewaySignature.test.ts)
