# LegalBridge プロトタイプ

Backlog を案件の起点にし、Local UI / DB が Backlog 情報を読んで動作する法務業務支援システムのプロトタイプです。Slack は必要に応じて通知・受付を担います。

期日管理も Backlog を正本に寄せます。納品期日、利用許諾計算の報告期限、支払期日は Backlog 課題の期限日またはカスタム属性へ保持し、Local / DB は補助情報として扱います。

---

## できること

| 機能 | 説明 |
|------|------|
| `/法務依頼` | Slackからフォーム入力 → Backlogに課題を自動起票 |
| `/法務検索` | 課題キー、相手方名、案件名などで親案件を検索 |
| `/法務ステータス LEGAL-XX` | 案件の進捗をSlack上で即確認 |
| `/法務一覧` | 直近8件の案件ステータスを一覧表示 |
| 納期アラート | 発注明細の納期を基準に、1週間前 / 3日前 / 当日 / 超過後毎日を指定チャンネルへ通知 |
| 法務相談 | `/法務依頼` の文書種別から、他社文書レビュー依頼と法務相談をまとめて受付 |
| 部署別通知ルール | 部署ごとに投稿チャンネル、上長ID、承認（押印）ID、実行（押印）ID を設定可能 |
| Backlog Webhook受信 | ステータス変更 → 文書自動生成 → Drive保管 → 完了通知 |

---

## 利用マニュアル

- 事業部向け Slack コマンド / 申請マニュアル: `docs/user/BUSINESS_SLASH_COMMAND_MANUAL.md`
- 新アーキテクチャ設計書: `docs/development/ARCHITECTURE_V2.md`
- docs 一覧: `docs/README.md`

## フロー図

```
Backlog
  ├─ 案件ヘッダ / ステータス / 期限 / 参照キーを保持
  └─ Webhook / Polling で Local に変化を通知
         ↓
[Local UI / Worker]
  ├─ Backlog課題を読んで初期表示
  ├─ DB / マスタで不足値を補完
  ├─ 文書生成・再生成
  ├─ Backlogコメント / ステータス更新
  └─ 必要に応じて Slack 通知

DB
  ├─ 下書き
  ├─ マスタ
  ├─ 履歴
  └─ 生成文書メタデータ
```

---

## セットアップ手順

### 1. 依存パッケージのインストール

```bash
cd legalbridge-proto
npm install
```

### 2. Slack App の作成

1. https://api.slack.com/apps にアクセス → **Create New App** → **From scratch**
2. App Name: `LegalBridge` / ワークスペースを選択

#### 必要なBot Tokenスコープ（OAuth & Permissions）
- `chat:write`
- `commands`
- `im:write`
- `channels:read`

#### スラッシュコマンドの登録（Slash Commands）
| コマンド | Request URL（後で設定） | 説明 |
|---------|------------------------|------|
| `/法務依頼` | （Socket Modeのため不要） | 依頼フォーム |
| `/法務ステータス` | （Socket Modeのため不要） | ステータス確認 |
| `/法務一覧` | （Socket Modeのため不要） | 案件一覧 |

#### Socket Mode の有効化
- **Socket Mode** タブ → Enable Socket Mode をON
- App-Level Token を生成（`connections:write` スコープを付与）→ `SLACK_APP_TOKEN` に設定

#### ワークスペースにインストール
- **Install App** タブ → Install to Workspace
- `Bot User OAuth Token` をコピー → `SLACK_BOT_TOKEN` に設定

### 3. Backlog の設定

1. BacklogでプロジェクトキーLEGALのプロジェクトを作成
2. 課題タイプに `法務相談` を追加
3. カスタム属性を追加（プロジェクト設定 → 課題の設定 → カスタム属性）:
   - 依頼部署（テキスト型）
   - 契約種別（テキスト型）
   - 相手方（テキスト型）
   - 希望完了日（日付型）
4. 発注書 / 企画発注書の運用では、明細JSONまたは管理UI取込により納期が `OrderItem.latestDueDate` へ入ることを確認
5. 各カスタム属性のIDを確認して `.env` の `BACKLOG_FIELD_*` に設定

### 4. Google Drive（サービスアカウント）の設定

1. [GCP Console](https://console.cloud.google.com/) でプロジェクト作成
2. **APIとサービス** → **Drive API** を有効化
3. **サービスアカウント** を作成 → JSONキーをダウンロード
4. キーファイルを `secrets/gws-service-account.json` に配置
5. Drive上の保管フォルダをサービスアカウントのメールアドレスと共有

### 5. 環境変数の設定

```bash
cp .env.example .env
# .env を編集して各値を設定
```

補足:

- `BACKLOG_ISSUE_TYPE_LEGAL_CONSULTATION` に Backlog 上の `法務相談` 課題タイプ名を設定
- `BACKLOG_ORDER_DUE_ALERT_EXCLUDED_STATUSES` で納期アラート対象外にするステータス名をカンマ区切りで設定
- 受付スレッドの投稿先や部署別通知先は `.env` ではなく `/admin/settings/workflow` で設定する
- `SLACK_BOT_TOKEN` や `SLACK_APP_TOKEN` が未設定でも、Backlog / Local / DB を主軸にした処理は継続できる
- 起動時に Backlog の主要課題タイプと主要カスタム属性の整合性チェックを行い、差分があれば警告ログを出す
- 公開用の Slack-Backlog 受付サービスは `npm run start:gateway` で本体とは別エントリーポイントとして起動できる
- CI では `npm run build` を常時実行し、必要な secrets / vars が揃う環境では `npm run gateway:check` も実行して gateway の blocking issue を検出できる

### 6. 起動

```bash
# 開発モード（ファイル変更を監視して自動再起動）
npm run dev

# 通常ローカル起動（Slack 接続あり）
start-local.cmd

# UI確認用（Slack接続なし、3100番で起動）
start-local-ui.cmd
```

補足:

- `start-local.cmd` と `start-local-ui.cmd` は `db` コンテナが停止している場合に `docker compose up -d db` を実行し、`localhost:5432` の応答を待ってからアプリを起動する
- 別のローカルコンテナや開発環境が `3000` を使っている場合、アプリは `3100` にフォールバックして起動する
- UI確認時は `http://localhost:3100/admin/workflow-settings` を使う
- ローカル運用時の確認口は `http://localhost:PORT/health`、`/ready`、`/status`、`/status.json`
- `/status` では `DB / Slack / Backlog Config / Scheduler / Poller` の状態をブラウザで確認できる

### 6.1 Cloud Run で Slash Command 受付だけを常時稼働させる

ローカルアプリが停止している間も Slash Command とモーダルを受けたい場合は、`src/cloudrun.ts` を使って Slack 受付専用の軽量サービスを Cloud Run に載せる。

必須:

- `SLACK_BOT_TOKEN`
- `SLACK_SIGNING_SECRET`
- `BACKLOG_API_KEY`
- `BACKLOG_SPACE`
- `BACKLOG_PROJECT_KEY`

あると便利:

- `GOOGLE_DRIVE_FOLDER_OPTIONS` など Drive フォルダ候補
- `BACKLOG_ISSUE_TYPE_*` 課題タイプ名
- `BACKLOG_FIELD_*` カスタムフィールド ID
- `SLACK_LEGAL_CHANNEL` など法務通知先
- `DATABASE_URL`（Cloud Run から DB 保存まで行いたい場合のみ）

ローカル確認:

```bash
npm run build
npm run start:cloudrun
```

公開エンドポイント:

- Slash Commands: `/slack/commands`
- Interactivity: `/slack/interactions`
- Health Check: `/health`

Docker ビルド例:

```bash
gcloud builds submit --tag gcr.io/YOUR_PROJECT_ID/legalbridge-slack-gateway -f Dockerfile.cloudrun
gcloud run deploy legalbridge-slack-gateway ^
  --image gcr.io/YOUR_PROJECT_ID/legalbridge-slack-gateway ^
  --platform managed ^
  --region asia-northeast1 ^
  --allow-unauthenticated
```

Slack App 設定:

- Slash Command Request URL: `https://YOUR_CLOUD_RUN_URL/slack/commands`
- Interactivity Request URL: `https://YOUR_CLOUD_RUN_URL/slack/interactions`

補足:

- この Cloud Run サービスは Slack の受付専用
- 文書生成、Backlog Webhook、管理 UI は従来どおりローカルアプリ側で動かせる
- 非機密設定は `cloudrun.gateway.env.example.yaml` をコピーして `cloudrun.gateway.env.yaml` を作る
- 機密値は `cloudrun.gateway.secrets.example.yaml` をコピーして `cloudrun.gateway.secrets.yaml` を作り、Cloud Run には Secret Manager 経由で注入する
- `DATABASE_URL` や `SLACK_LEGAL_CHANNEL` が未設定でも Backlog 起票までは継続し、DB 保存や法務通知だけをスキップする
- デプロイは `scripts/deploy-cloudrun.ps1 -ProjectId YOUR_PROJECT_ID -MaxInstances 3` で実行できる
- 想定外課金を抑えるため、Cloud Run は `--max-instances` で上限を固定する

### 7. Backlog Webhook の設定（ローカル開発時）

通常のローカル利用では ngrok は不要です。Admin UI と文書生成補助はそのまま使えます。

Backlog の webhook をローカル PC で直接受けたい場合だけ、インターネット越しに届く HTTPS 公開 URL が必要になるため、ngrok を使います。

```bash
# 別ターミナルで実行
npx ngrok http 3000

# 表示された https://xxxx.ngrok.io を使って
# Backlog → プロジェクト設定 → Webhook → 追加
# URL: https://xxxx.ngrok.io/webhook/backlog
# 通知するイベント: 課題の追加, 課題の更新 にチェック
```

---

## ファイル構成

```
legalbridge-proto/
├── src/
│   ├── index.ts                 # エントリーポイント
│   ├── slack/
│   │   └── handlers.ts          # Slackコマンド・モーダルハンドラー
│   ├── backlog/
│   │   └── client.ts            # Backlog API クライアント
│   ├── documents/
│   │   └── generator.ts         # 文書生成 + Drive保管
│   └── webhook/
│       └── backlog.ts           # Backlog Webhook受信・処理
├── templates/                   # HTMLテンプレート（Handlebars）
│   ├── purchase_order.html      # ← 既存テンプレートをここに置く
│   ├── payment_notice.html
│   ├── inspection_cert.html
│   └── nda.html
├── secrets/                     # .gitignore 対象
│   └── gws-service-account.json
├── tmp/                         # 一時生成ファイル（自動作成）
├── .env                         # .gitignore 対象
├── .env.example
├── package.json
├── tsconfig.json
└── README.md
```

---

## WeasyPrint のインストール（PDF生成に必要）

WeasyPrintが未インストールの場合はHTMLのままDriveに保管します。

```bash
# macOS
brew install weasyprint

# Ubuntu / Debian
pip install weasyprint --break-system-packages
```

---

## トラブルシューティング

**Slackコマンドが反応しない**
→ Socket Modeが有効になっているか確認。アプリの再インストールが必要な場合あり。

**Backlogへの起票に失敗する**
→ `BACKLOG_API_KEY` と `BACKLOG_SPACE` を確認。カスタム属性IDが正しいか確認。

**Driveアップロードに失敗する**
→ サービスアカウントのJSONパスと保管フォルダIDを確認。フォルダをサービスアカウントと共有しているか確認。

**Staff / Vendor CSV を取り込むと文字化けする**
→ 管理UIの一括取込は `UTF-8` と `Shift_JIS` の自動判定に対応済み。再読み込み後に同じ CSV を再取込する。

**過去に文字化けした Staff データを取り込んでしまった**
→ 元の CSV を正しい文字コードで再取込して上書きする。`slackUserId` をキーに既存 Staff を更新する前提なので、同じユーザーIDで再投入すればクリーニングできる。
