# IGLA 海外向けテンプレート当てはめ検討メモ

## 結論

- 現行モジュールには十分当てはめ可能。
- ただし、`ライセンスアウト` と `プロダクトアウト` を単なるテンプレート差し替えで扱うより、`契約ストラクチャー + 可変条項ブロック` として実装した方が保守しやすい。
- さらに、`ライセンスアウト -> プロダクトアウト` / `プロダクトアウト -> ライセンスアウト` / `変更合意` を扱うなら、主契約1本だけで吸収するより、`基本契約 + 変更合意書` または `基本契約 + 別紙/追加合意` の構造で管理した方が既存実装に乗せやすい。

## 現行実装との適合ポイント

### 1. 文書種別の追加余地

現行は文書種別を以下で定義している。

- `src/workflow/documentRequestConfig.ts`
- `src/workflow/documentRequestFields.ts`
- `src/documents/templateRegistry.ts`

このため、新規契約種別を増やす余地はある。

想定追加候補:

- `license_out_master`
- `product_out_master`
- `license_product_amendment`

ただし UI や Slack の選択肢上は、文書種別を増やしすぎるより、上位で `海外IP契約` を1つ置いて、その中で方式を切り替える方が自然。

### 2. テンプレート生成方式との相性

現行は Handlebars ベースで、

- テンプレートキー選択
- 変数投入
- 複数文書同時生成

まで対応済み。

利用箇所:

- `src/documents/templateRenderer.ts`
- `src/webhook/backlog.ts`

特にライセンス契約はすでに `基本契約 + 個別条件` の複数文書生成を持っているため、今回のような

- 基本契約
- 別紙
- 変更合意

の組み合わせは設計上かなり近い。

### 3. 既存ライセンス導線との親和性

現行設計では既に

- `ライセンス契約`
- `個別利用許諾条件`

を分離する思想が入っている。

参照:

- `docs/development/LICENSE_WORKFLOW_DESIGN.md`

そのため、今回の IGLA 系ひな形も、以下のどちらかで載せやすい。

1. `海外向けライセンスアウト基本契約` + `個別条件`
2. `海外向けIP事業化契約` + `変更合意書`

## 推奨するスイッチの置き場所

### 推奨

文書種別そのものを増やす前に、契約ファミリー内に `deal_structure` を持たせる。

候補:

- `license_out`
- `product_out`
- `convert_license_to_product`
- `convert_product_to_license`
- `amendment`

追加位置の第一候補:

- `src/workflow/documentRequestFields.ts`
- `src/admin/routes.ts` の Backlog フィールド変換部
- `src/webhook/backlog.ts` のレンダリング変数組み立て部

### 理由

- ユーザーの入口は1つに保ちやすい
- 将来の派生形を増やしやすい
- Backlog の課題タイプ乱立を防げる
- 変更合意を「契約タイプの再選択 + 差分入力」で表現しやすい

## 推奨データモデル

最低限、以下の概念を持たせるのがよい。

- `contract_family`: `ip_overseas`
- `deal_structure`: `license_out` / `product_out`
- `change_mode`: `none` / `license_to_product` / `product_to_license` / `amendment`
- `base_agreement_key`: 元契約の課題キー
- `effective_date`: 変更効力発生日
- `superseded_clauses`: 差し替え対象条項

さらに条項差分をテンプレートで吸収するため、

- `grant_model`
- `revenue_model`
- `title_transfer_model`
- `inventory_selloff_model`
- `sublicense_allowed`

のような論点単位フラグを持つとよい。

## 実装方式の比較

### A. テンプレートを2本に分ける

- `template_ip_license_out.html`
- `template_ip_product_out.html`

利点:

- 初期実装が早い
- 法務レビューしやすい

弱点:

- 共通条項の重複が増える
- 将来の変更合意に弱い

### B. 共通テンプレート1本 + 条項スイッチ

- `template_ip_master_agreement.html`
- `{{#if isLicenseOut}} ... {{/if}}`
- `{{#if isProductOut}} ... {{/if}}`
- `{{#if isConversionAmendment}} ... {{/if}}`

利点:

- 共通条項の保守がしやすい
- 変更合意に展開しやすい

弱点:

- 初回のテンプレート設計がやや重い
- 変数設計を先に整理する必要がある

### 推奨判断

今回の要件では B を推奨。

理由:

- 単純な2類型ではなく、相互変換と変更合意が前提
- 既存の `license + ledger` 構造と合わせて、可変ブロック化の方が中長期で安定する

## 既存モジュールへの当てはめ方

### 1. 受付定義

`src/workflow/documentRequestConfig.ts` に新規タイプを追加する。

候補:

- `ip_overseas_master`
- `ip_overseas_amendment`

### 2. 設問定義

`src/workflow/documentRequestFields.ts` に以下を追加する。

- 取引構造
- 変更有無
- 元契約キー
- 効力発生日
- 権利許諾対象
- 製品化対象
- 収益分配条件
- サブライセンス可否
- 在庫処理
- 変更対象条項

### 3. Backlog 反映

`src/admin/routes.ts` の `type` ごとの custom field 組立に、上記フィールドを追加する。

ここで `deal_structure` と `change_mode` を保存できれば、後段のレンダリング分岐は作りやすい。

### 4. テンプレート登録

`src/documents/templateRegistry.ts` に追加。

候補:

- `ip_overseas_master`
- `ip_overseas_amendment`

### 5. レンダリング組立

`src/webhook/backlog.ts` の `buildRenderItemsForIssue()` に IGLA 用の分岐を追加する。

ここで、

- 共通変数
- ライセンスアウト専用変数
- プロダクトアウト専用変数
- 変更合意専用変数

を合成する。

## 変更合意の扱い

今回の要件では、変更合意は独立文書として持つのが安全。

理由:

- 元契約との関係を明示できる
- 締結履歴が追いやすい
- `A -> B` と `B -> A` を同一ロジックで扱える

推奨文書構成:

- 主契約: `海外向けIP契約`
- 変更合意書: `取引構造変更合意書`

変更合意書で持つべき項目:

- 元契約番号
- 元契約締結日
- 変更前構造
- 変更後構造
- 効力発生日
- 置換条項
- 存続条項

## 現時点の注意点

- 指定の `IGLA_MasterAgreement_EN_v3.docx` は、この作業時点では別プロセスがファイルを保持しており本文の直接抽出ができなかった。
- そのため、上記評価は現行コードベースと既存ライセンス/売買テンプレート構造を基準にした当てはめ判断。
- 実装着手前に、元 Word の条番号構成と可変条項の位置だけは確認したい。

## 実装優先順位

1. Word 原本の条項を `共通条項 / license out 専用 / product out 専用 / amendment 専用` に分解
2. `deal_structure` と `change_mode` の入力項目を追加
3. Handlebars テンプレートを1本または2本で作成
4. `buildRenderItemsForIssue()` に専用分岐を追加
5. Backlog カスタムフィールド ID を `.env` に追加
6. UI と Slack の設問を整える

## 最終提案

- 従来モジュールへの当てはめは可能
- 実装方針は `新しい契約ファミリーを追加し、その内部に取引構造スイッチを持たせる` が最適
- `変更合意` は主契約内の分岐ではなく、独立文書として持たせるのが運用・証跡の両面で安全
