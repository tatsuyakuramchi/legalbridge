# DB セットアップ手順

## ローカルPostgreSQLのインストールと初期設定

### macOS

```bash
# PostgreSQL 15 をインストール
brew install postgresql@15

# 起動
brew services start postgresql@15

# DBとユーザーを作成
psql postgres -c "CREATE DATABASE legalbridge;"
psql postgres -c "CREATE USER postgres WITH PASSWORD 'password';"
psql postgres -c "GRANT ALL PRIVILEGES ON DATABASE legalbridge TO postgres;"
```

### Windows（WSL2 / Ubuntu）

```bash
sudo apt update
sudo apt install postgresql postgresql-contrib

sudo service postgresql start
sudo -u postgres psql -c "CREATE DATABASE legalbridge;"
sudo -u postgres psql -c "ALTER USER postgres PASSWORD 'password';"
```

---

## Prismaのセットアップ

```bash
cd legalbridge-proto

# 依存パッケージのインストール
npm install

# Prismaクライアントを生成（スキーマからTypeScriptの型を自動生成）
npm run db:generate

# マイグレーションを実行（テーブルを作成）
npm run db:migrate
# → "init" などのマイグレーション名を入力

# GUI確認（ブラウザでDB内容を確認できる）
npm run db:studio
```

補足:

- 追加マイグレーションとして `OrderDueReminderLog` と `DepartmentWorkflowRule.postChannelId` を利用する
- `prisma generate` が `query_engine-windows.dll.node` のロックで失敗する場合は、アプリ停止後に再実行する
- `Vendor.phone` と `Vendor.isInvoiceIssuer` を追加した以降は、Vendor マスタを電話番号・インボイス発行事業者込みで管理する

---

## Staff / Vendor CSV の文字コード運用

- 管理UIのマスタ一括取込は `UTF-8` と `Shift_JIS` の自動判定に対応している
- 取込完了メッセージに判定した文字コードが表示される
- Windows の業務 CSV は `Shift_JIS` のことが多いため、サンプル検証時は両方で確認しておく

### 文字化けした Staff データの再取込

1. 元の CSV を管理UIから再度アップロードする
2. 文字コード表示が想定どおりか確認する
3. `slackUserId` が一致する既存レコードは上書き更新される
4. 一括取込後に管理UIか `prisma studio` で氏名・部署名が正常表示されることを確認する

補足:

- 既に文字化けしたデータが入っていても、正しい CSV を再取込すればクリーニングできる
- Staff は `slackUserId` をキーに更新されるため、再取込時はこの列を欠かさない

---

## RDS（本番）への移行

ローカルで動作確認が完了したら、`.env` の `DATABASE_URL` を切り替えるだけ。

```bash
# .env を編集
DATABASE_URL=postgresql://dbuser:dbpass@xxx.rds.amazonaws.com:5432/legalbridge

# 本番DBにマイグレーションを適用（migrate deploy = ロールバックなしで安全）
npm run db:deploy
```

ローカルとRDSは**完全に同じスキーマ・同じコード**で動作する。

---

## テーブル構成

| テーブル | 用途 |
|---------|------|
| `LicenseContract` | ライセンス台帳（Backlog課題と1:1） |
| `ManufacturingEvent` | 製造案件・ロイヤリティ計算結果のスナップショット |
| `RoyaltyPayment` | 支払記録・消込管理 |
| `LegalRequest` | Slackからの法務依頼受付履歴 |
| `OrderItem` | 発注明細。納期アラート基準となる `latestDueDate` を保持 |
| `OrderDueReminderLog` | 納期アラートの重複送信防止ログ |
| `Staff` | 申請者マスタ。部署別通知ルール解決の起点 |
| `Vendor` | 相手方マスタ。住所、電話、メール、口座、インボイス、基本契約参照を保持 |
| `DepartmentWorkflowRule` | 部署別の投稿チャンネル / 上長ID / 承認（押印）ID / 実行（押印）ID を保持 |

### Vendor マスタ補足

Vendor マスタでは少なくとも次を管理する。

- `address`
- `phone`
- `email`
- `contactName`
- `bankName`
- `branchName`
- `accountType`
- `accountNumber`
- `accountHolderKana`
- `isInvoiceIssuer`
- `invoiceRegistrationNumber`
- `masterContractRef`

発注書系とライセンス契約系の文書生成は、Backlog や下書きに未入力がある場合にこれらを補完元として利用する。

---

## MGの累積管理について

MG消化額は **DBのみを正** として管理する。

```
製造イベント発生
  ↓ calculateRoyalty() で計算
  ↓ saveManufacturingEvent() でDBに保存
  ↓ incrementMgConsumed() でLicenseContractのmgConsumedToDateを加算
     ← Prismaのアトミックな increment を使うので競合しない
  ↓ （参考情報として）Backlogのカスタムフィールドにも書き戻す
```

次回の製造イベントでは `findLicenseByBacklogKey()` でDBからMG消化累積額を取得するため、Backlogフィールドがずれていても影響しない。
