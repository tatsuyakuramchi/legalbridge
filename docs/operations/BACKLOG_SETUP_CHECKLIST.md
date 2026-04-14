# Backlog Setup Checklist

更新日: 2026-04-14

## 目的

LegalBridge の現行運用では、Backlog は `ステータス管理 + 任意の補足欄` に限定して使う。  
文書生成の詳細条件や帳票向け情報は DB / 管理 UI 側で保持する。

本書は、Backlog 側で最低限整えておくべき項目を整理したチェックリストである。

## 先に作る課題タイプ

- NDA
- 業務委託基本契約
- ライセンス契約
- 個別利用許諾条件
- 海外IP契約（基本契約）
- 海外IP契約（変更合意）
- 法務相談
- 売買契約（当社買手）
- 売買契約（当社売手・標準）
- 売買契約（当社売手・保証金掛け売り）
- 発注書
- 企画発注書
- 出版発注書
- 納品リクエスト
- 製造案件
- 売上報告案件

## 現在 Backlog に残すカスタム属性

以下は現行運用で Backlog に残している属性である。  
ただし、**すべて任意項目** として扱う。

### 共通補足

- `相手方`
- `希望期限`
- `備考`
- `文書番号`

### 契約系・発注系の最小ヘッダ

- `契約日・発注日`
- `契約期間`
- `案件名`

### 個別利用許諾条件 / 後続課題の参照

- `親ライセンス課題キー`
- `許諾開始日`
- `親課題キー`
- `明細番号`

### 納品リクエスト

- `納品備考`
- `今回納品金額`
- `納期 / 校了予定`
- `検収日`
- `支払予定日`

### 利用許諾料計算

- `製品名 / 対象商品名`
- `版`
- `製造完了日`
- `数量`
- `MSRP`
- `サンプル数量`
- `報告対象期間開始`
- `報告対象期間終了`
- `売上高・正味売上高`
- `報告期限`
- `支払期限`

## 作らない / Backlog から外す項目

次のような項目は Backlog 側で持たない前提とする。

- 相手方住所
- 相手方代表者
- 特記事項
- NDA 目的
- 秘密保持期間
- 管轄裁判所
- 原著作物 / 原著作者 / クレジット表記
- 素材情報群
- `CONDITION1_*` `CONDITION2_*` `CONDITION3_*`
- 発注書・売買契約の詳細支払条件
- 帳票専用の補助値

これらは DB / 管理 UI / 文書生成ロジック側で保持する。

## 運用ルール

- Backlog カスタム属性は、設定済みでも未入力で構わない
- Slack モーダルで取る最小情報だけで起票を成立させる
- 詳細条件は管理 UI または DB 側で補完する
- Backlog で未設定でも、blocking にはしない

## `.env` / Cloud Run 反映手順

1. Backlog に課題タイプを作成する
2. 必要なカスタム属性だけを作成する
3. 属性 ID を `BACKLOG_FIELD_*` に反映する
4. Cloud Run の env を更新する
5. `/health` と Admin UI の同期画面を確認する

## 確認ポイント

- `legalbridge-slack-gateway /health` が `200`
- Admin UI の Backlog Config に blocking issue が出ていない
- 手動同期が成功する
- 海外IP課題タイプ 2種が Backlog 上に存在する

## 関連資料

- [Current GCP System Configuration](C:/Users/tatsuya.kuramochi/Desktop/legalbrigde-proto_GCP/docs/operations/CURRENT_GCP_SYSTEM_CONFIGURATION.md)
- [Backlog Field Reduction Candidates](C:/Users/tatsuya.kuramochi/Desktop/legalbrigde-proto_GCP/docs/operations/BACKLOG_FIELD_REDUCTION_CANDIDATES.md)
- [Backlog Field Mapping Guide](C:/Users/tatsuya.kuramochi/Desktop/legalbrigde-proto_GCP/docs/development/BACKLOG_FIELD_MAPPING_GUIDE.md)
