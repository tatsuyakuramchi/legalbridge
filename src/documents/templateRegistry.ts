/**
 * src/documents/templateRegistry.ts
 * テンプレート台帳
 *
 * 添付テンプレートを「正」として整理した全テンプレートの定義。
 * Backlogの課題タイプ・ステータスと生成文書の対応関係を一元管理する。
 *
 * ================================================================
 * テンプレート一覧（添付ファイルを正とする）
 * ================================================================
 *
 * ── 契約書 ──────────────────────────────────────────────────────
 * template_nda.html
 *   文書名: 秘密保持契約書
 *   変数形式: {{UPPER_SNAKE_CASE}}
 *   主要変数: PARTY_A_NAME, PARTY_B_NAME, NDA_PURPOSE, CONTRACT_PERIOD,
 *             CONFIDENTIALITY_PERIOD, JURISDICTION, CONTRACT_DATE_FORMATTED,
 *             PARTY_A_ADDRESS, PARTY_A_REP, PARTY_B_ADDRESS, PARTY_B_REP
 *
 * template_service_basic.html
 *   文書名: 業務委託基本契約書
 *   変数形式: {{UPPER_SNAKE_CASE}}
 *   主要変数: PARTY_A_NAME, PARTY_A_ADDRESS, PARTY_A_REP,
 *             VENDOR_NAME, VENDOR_ADDRESS, VENDOR_REP, VENDOR_EMAIL, VENDOR_PHONE,
 *             CONTRACT_DATE_YEAR/MONTH/DAY, IS_INVOICE_ISSUER, invoiceRegistrationDisplay,
 *             BANK_NAME, BRANCH_NAME, ACCOUNT_TYPE, ACCOUNT_NUMBER, ACCOUNT_HOLDER_KANA,
 *             REMARKS
 *
 * template_sales_buyer.html
 *   文書名: 売買基本契約書（当社買手）
 *   変数形式: {{UPPER_SNAKE_CASE}}
 *   主要変数: CONTRACT_NO, CONTRACT_DATE_FORMATTED,
 *             PARTY_B_NAME, PARTY_B_ADDRESS, PARTY_B_REPRESENTATIVE,
 *             PRODUCT_SCOPE, DELIVERY_LOCATION, INSPECTION_PERIOD_DAYS,
 *             PAYMENT_CONDITION_SUMMARY, WARRANTY_PERIOD,
 *             CONFIDENTIALITY_YEARS, CURE_PERIOD_DAYS, JURISDICTION, SPECIAL_TERMS
 *
 * template_sales_seller_standard.html
 *   文書名: 売買基本契約書（当社売手・前払/代引）
 *   変数形式: {{UPPER_SNAKE_CASE}}
 *   主要変数: CONTRACT_NO, CONTRACT_DATE_FORMATTED,
 *             PARTY_B_NAME, PARTY_B_ADDRESS, PARTY_B_REPRESENTATIVE,
 *             DELIVERY_DAYS_AFTER_PAYMENT, COD_DELIVERY_DAYS, PREPAY_DEADLINE_DAYS,
 *             INSPECTION_PERIOD_DAYS, WARRANTY_PERIOD,
 *             CONFIDENTIALITY_YEARS, JURISDICTION, SPECIAL_TERMS
 *
 * template_sales_seller_credit.html
 *   文書名: 売買基本契約書（当社売手・掛売）
 *   変数形式: {{UPPER_SNAKE_CASE}}
 *   主要変数: CONTRACT_NO, CONTRACT_DATE_FORMATTED,
 *             PARTY_B_NAME, PARTY_B_ADDRESS, PARTY_B_REPRESENTATIVE,
 *             MONTHLY_CLOSING_DAY, PAYMENT_DUE_DAY,
 *             SECURITY_DEPOSIT_AMOUNT, DEPOSIT_REPLENISH_DAYS, DELIVERY_FEE_THRESHOLD,
 *             INSPECTION_PERIOD_DAYS, WARRANTY_PERIOD,
 *             CONFIDENTIALITY_YEARS, JURISDICTION, SPECIAL_TERMS
 *
 * template_license_basic.html
 *   文書名: ライセンス利用許諾基本契約書
 *   変数形式: {{UPPER_SNAKE_CASE}} + {{日本語変数}}（混在）
 *   主要変数: CONTRACT_NO, PARTY_A_NAME, PARTY_A_ADDRESS, PARTY_A_REP,
 *             VENDOR_NAME, VENDOR_ADDRESS, VENDOR_REP, VENDOR_PHONE, VENDOR_EMAIL,
 *             BANK_NAME, BRANCH_NAME, ACCOUNT_TYPE, ACCOUNT_NUMBER, ACCOUNT_HOLDER_KANA,
 *             IS_INVOICE_ISSUER, invoiceRegistrationDisplay,
 *             REMARKS, JURISDICTION
 *   ※ PARTY_A = 株式会社アークライト（ライセンシー）固定
 *   ※ VENDOR = ライセンサー（相手方）
 *
 * template_ip_overseas_master.html
 *   文書名: 海外IP契約（基本契約）
 *   変数形式: {{UPPER_SNAKE_CASE}}
 *   主要変数: CONTRACT_NO, CONTRACT_DATE_FORMATTED,
 *             COUNTERPARTY_NAME, COUNTERPARTY_ADDRESS, COUNTERPARTY_REPRESENTATIVE,
 *             COUNTERPARTY_NOTICE_CONTACT, PARTY_A_NOTICE_CONTACT,
 *             ORIGINAL_WORK, TERRITORY, LANGUAGE_SCOPE, EXCLUSIVITY,
 *             INITIAL_TERM, RENEWAL_TERMS, NON_RENEWAL_NOTICE,
 *             SELL_OFF_PERIOD, CURRENCY, DEAL_STRUCTURE, APPLICABLE_SUPPLEMENTAL_TERMS,
 *             S1_ROYALTY_RATE, S1_MINIMUM_GUARANTEE, S1_ADVANCE,
 *             S1_ACCOUNTING_PERIOD, S1_REPORT_DUE, S1_PAYMENT_DUE,
 *             S2_PRODUCT_PRICE_LIST, S2_MPR_YEAR1, S2_INCOTERMS_DELIVERY,
 *             SCHEDULE_1_SUMMARY, SCHEDULE_1_SPECIAL_PROVISIONS,
 *             SCHEDULE_2_SUMMARY, SCHEDULE_2_SPECIAL_PROVISIONS
 *
 * template_ip_overseas_amendment.html
 *   文書名: 海外IP契約変更合意書
 *   変数形式: {{UPPER_SNAKE_CASE}}
 *   主要変数: CONTRACT_NO, CONTRACT_DATE_FORMATTED, BASE_AGREEMENT_KEY,
 *             EFFECTIVE_DATE, CHANGE_MODE, DEAL_STRUCTURE, ORIGINAL_WORK,
 *             AMENDMENT_CLAUSES, LICENSE_SCOPE, IP_PRODUCT_SCOPE,
 *             TERRITORY, REVENUE_MODEL, ROYALTY_TERMS,
 *             INVENTORY_SELLOFF, TITLE_TRANSFER_MODEL, SPECIAL_NOTES
 *   ※ 基本契約の変更合意に特化し、変更対象条項と構造切替を短く整理する
 *
 * ── 別紙・附属 ──────────────────────────────────────────────────
 * template_ledger_v5.html
 *   文書名: 別紙 個別利用許諾条件
 *   変数形式: {{日本語変数}}（Handlebars）
 *   主要変数: 台帳ID, 契約書番号, 基本契約名, 発行日,
 *             licensor名, licensor_氏名会社名, licensor_住所, licensor_代表者名,
 *             licensee名, licensee_氏名会社名, licensee_住所, licensee_代表者名,
 *             ライセンス種別名, 原著作物名, 原著作物補記, 対象製品予定名,
 *             許諾開始日, 許諾期間注記, 素材番号, 素材名, 素材権利者, 監修者,
 *             金銭条件1_地域言語ラベル, 金銭条件1_計算方式, 金銭条件1_計算式,
 *             金銭条件1_基準価格ラベル, 金銭条件1_料率, 金銭条件1_計算期間,
 *             金銭条件1_通貨, 金銭条件1_支払条件, 金銭条件1_MG_AG, 金銭条件1_補足条件,
 *             金銭条件2_見出し〜（金銭条件3まで）, 特記事項_本文
 *   ※ template_license_basic と合冊生成
 *
 * terms_spot_2026.html
 *   文書名: 業務委託基本契約約款（スポット契約用）
 *   変数形式: なし（固定テキスト）
 *   ※ template_order.html で HAS_BASE_CONTRACT=false のとき自動添付
 *
 * ── 発注書 ──────────────────────────────────────────────────────
 * template_order.html
 *   文書名: 発注書（標準）
 *   変数形式: {{UPPER_SNAKE_CASE}} + items配列
 *   主要変数: ORDER_NO, ORDER_DATE_YEAR/MONTH/DAY,
 *             VENDOR_NAME, VENDOR_SUFFIX, VENDOR_ADDRESS, VENDOR_EMAIL,
 *             VENDOR_CONTACT_NAME, VENDOR_CONTACT_DEPARTMENT,
 *             PARTY_A_NAME, PARTY_A_ADDRESS, PARTY_A_REP,
 *             STAFF_NAME, STAFF_DEPARTMENT, STAFF_PHONE, STAFF_EMAIL,
 *             PROJECT_TITLE, grandTotalExTax, summaryDeliveryDate, summaryPaymentTerms,
 *             items[]: {category, item_name, payment_method_display, qty, unitPrice, amount, detailText}
 *             HAS_BASE_CONTRACT, MASTER_CONTRACT_REF,
 *             BANK_NAME, BRANCH_NAME, ACCOUNT_TYPE, ACCOUNT_NUMBER, ACCOUNT_HOLDER_KANA,
 *             INVOICE_REGISTRATION_NUMBER, TRANSFER_FEE_PAYER,
 *             SPECIAL_TERMS, REMARKS, REMARKS_FIXED, REMARKS_FREE,
 *             SHOW_ORDER_SIGN_SECTION, ACCEPT_METHOD, ACCEPT_REPLY_DUE_DATE,
 *             ACCEPT_BY_PERFORMANCE, SHOW_SIGN_SECTION, VENDOR_ACCEPT_DATE
 *
 * template_order_planning.html
 *   文書名: 発注書（企画・クリエイター向け）
 *   変数形式: {{UPPER_SNAKE_CASE}}
 *   主要変数: ORDER_NO, ORDER_DATE_YEAR/MONTH/DAY,
 *             PARTY_A_NAME, PARTY_A_ADDRESS, PARTY_A_REP,
 *             STAFF_NAME, STAFF_DEPARTMENT, STAFF_PHONE, STAFF_EMAIL,
 *             PROJECT_TITLE, ITEM_NAME, PAYMENT_TERMS,
 *             FIRST_DRAFT_DEADLINE, FINAL_DEADLINE,
 *             MASTER_CONTRACT_REF, SPECIAL_TERMS, REMARKS,
 *             BANK_NAME, BRANCH_NAME, ACCOUNT_TYPE, ACCOUNT_NUMBER, ACCOUNT_HOLDER_KANA,
 *             INVOICE_REGISTRATION_NUMBER, BANK_INFO, TRANSFER_FEE_PAYER,
 *             ACCEPT_METHOD, ACCEPT_REPLY_DUE_DATE
 *
 * ── 検収・精算書類 ───────────────────────────────────────────────
 * template_inspection_report.html
 *   文書名: 検収書
 *   変数形式: {{lower_snake_case}} + items配列
 *   主要変数: delivery_id, vendor_name, vendor_invoice_num,
 *             order_no, contract_no, project_name,
 *             items[]: {name, order_no, spec, no, qty, amount_ex_tax,
 *                       hasRevision, revisionDetail,
 *                       hasAmountChange, originalAmount, newAmount, amountChangeReason,
 *                       isCompleted, partial_number, total_partials, is_final_delivery,
 *                       milestone_name, delivery_url, notes}
 *             totalExTax, totalIncTax,
 *             approver_name, approver_department,
 *             reviewer_name, reviewer_department,
 *             person_name, person_department, approval_date, approval_comments
 *
 * template_payment_notice_actual.html  ← 正テンプレート（旧payment_notice.htmlと置換）
 *   文書名: お支払いのご案内（支払通知書）
 *   変数形式: {{lower_snake_case}} + {{UPPER_SNAKE_CASE}} 混在
 *   主要変数: notice_id, notice_date, vendor_name, vendorSuffix, vendor_invoice_num,
 *             SENDER_NAME, INVOICE_REGISTRATION_NUMBER, SENDER_ZIP, SENDER_ADDRESS, SENDER_DEPT, STAFF_NAME,
 *             totalWithTax, expenseAmount, withholdingTax, paymentAmount,
 *             showWithholdingNote, withholdingRateLabel,
 *             items[]: {order_no, name, detail, amount}
 *             payment_due_date,
 *             BANK_NAME, BRANCH_NAME, ACCOUNT_TYPE, ACCOUNT_NUMBER, BANK_ACCOUNT_NAME
 *
 * template_royalty_report_actual.html  ← 正テンプレート（旧royalty_report.htmlと置換）
 *   文書名: 利用許諾報告書
 *   変数形式: {{UPPER_SNAKE_CASE}} + items配列
 *   主要変数: NOTICE_ID, ISSUE_DATE, VENDOR_NAME, VENDOR_INVOICE_NUM, ORDER_NO,
 *             items[]: {date, name, period_text, detail, order_no, qty, rate, amount, deduction, deduction_note}
 *             TOTAL_NONTAX, TOTAL_NET
 *
 * template_revenue_share_report.html
 *   文書名: 業務委託報酬計算書（レベニューシェア）
 *   変数形式: {{UPPER_SNAKE_CASE}} + items配列
 *   主要変数: NOTICE_ID, ISSUE_DATE, CONTRACTOR_NAME, CONTRACTOR_INVOICE_NUM,
 *             ORDER_NO, PAYMENT_DATE, PAYMENT_METHOD,
 *             items[]: {period, name, detail, calculation, baseAmount, rate, amount, deduction, deduction_note, note}
 *             TOTAL_NONTAX, MINIMUM_GUARANTEE, TOTAL_NET, SPECIAL_NOTE
 */

// ================================================================
// テンプレートマップ（課題タイプ名 → 使用テンプレートファイル）
// ================================================================

export const TEMPLATE_MAP = {
  // 契約書
  nda:                    "template_nda.html",
  service_basic:          "template_service_basic.html",
  sales_buyer:            "template_sales_buyer.html",
  sales_seller_standard:  "template_sales_seller_standard.html",
  sales_seller_credit:    "template_sales_seller_credit.html",
  license_basic:          "template_license_basic.html",   // ledger_v5と合冊
  license_ledger:         "template_ledger_v5.html",
  ip_overseas_master:     "template_ip_overseas_master.html",
  ip_overseas_amendment:  "template_ip_overseas_amendment.html",

  // 発注書
  order:                  "template_order.html",
  order_planning:         "template_order_planning.html",
  spot_terms:             "terms_spot_2026.html",          // order.htmlに自動添付

  // 検収・精算
  inspection:             "template_inspection_report.html",
  payment_notice:         "template_payment_notice_actual.html",
  royalty_report:         "template_royalty_report_actual.html",
  revenue_share_report:   "template_revenue_share_report.html",
} as const;

export type TemplateKey = keyof typeof TEMPLATE_MAP;

// ================================================================
// Backlog課題タイプ名 → TemplateKeyのマッピング
// ================================================================
// .envで BACKLOG_ISSUE_TYPE_XXX を設定しない場合のデフォルト値

export const ISSUE_TYPE_TO_TEMPLATE: Record<string, TemplateKey[]> = {
  // 課題タイプ名（Backlogの設定に合わせる）: [生成するテンプレートのリスト]
  "NDA": ["nda"],
  "業務委託基本契約": ["service_basic"],
  "業務委託契約": ["service_basic"],
  "売買契約（当社買手）": ["sales_buyer"],
  "売買契約（買手）": ["sales_buyer"],
  "売買契約（当社売手・標準）": ["sales_seller_standard"],
  "売買契約（売手・前払）": ["sales_seller_standard"],
  "売買契約（当社売手・保証金掛け売り）": ["sales_seller_credit"],
  "売買契約（売手・掛売）": ["sales_seller_credit"],
  "ライセンス契約": ["license_basic", "license_ledger"],   // 2文書合冊
  "個別利用許諾条件": ["license_ledger"],
  "海外IP契約（基本契約）": ["ip_overseas_master"],
  "海外IP契約（変更合意）": ["ip_overseas_amendment"],
  "発注書": ["order"],
  "企画発注書": ["order_planning"],
  "製造案件": [],   // royalty.tsで処理
  "納品リクエスト": ["inspection"],                         // orderRepository経由
  "納品報告": ["inspection"],                               // 旧名称互換
};

// ================================================================
// 変数形式の定義（テンプレートごとの差異を吸収するため）
// ================================================================

export const TEMPLATE_VAR_STYLE: Record<TemplateKey, "upper" | "lower" | "japanese" | "mixed"> = {
  nda:                    "upper",
  service_basic:          "upper",
  sales_buyer:            "upper",
  sales_seller_standard:  "upper",
  sales_seller_credit:    "upper",
  license_basic:          "mixed",    // UPPER + 日本語変数（承継覚書日付 等）
  license_ledger:         "japanese", // 日本語変数のみ
  ip_overseas_master:     "upper",
  ip_overseas_amendment:  "upper",
  order:                  "mixed",    // UPPER + items配列
  order_planning:         "upper",
  spot_terms:             "upper",    // 変数なし（固定テキスト）
  inspection:             "lower",    // lower_snake_case + items配列
  payment_notice:         "mixed",    // lower + UPPER 混在
  royalty_report:         "upper",    // UPPER + items配列
  revenue_share_report:   "upper",    // UPPER + items配列
};

// ================================================================
// アークライト固定値（全テンプレートに共通で注入する値）
// ================================================================

export const ARCLIGHT_DEFAULTS = {
  PARTY_A_NAME:    "株式会社アークライト",
  PARTY_A_ADDRESS: "〒101-0052 東京都千代田区神田小川町1-2 風雲堂ビル2階",
  PARTY_A_REP:     "代表取締役 青柳昌行",
  SENDER_NAME:     "株式会社アークライト",
  SENDER_ZIP:      "101-0052",
  SENDER_ADDRESS:  "東京都千代田区神田小川町1-2 風雲堂ビル2階",
  SENDER_DEPT:     "法務部",
  JURISDICTION:    "東京地方裁判所",

  // 固定値（請求書登録番号等は実際の番号に差し替え）
  INVOICE_REGISTRATION_NUMBER: "T0000000000000",
} as const;
