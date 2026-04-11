/**
 * documents/royalty.ts
 * ロイヤリティ計算エンジン
 *
 * 個別利用許諾条件書の条件 + 製造イベントデータから
 * 当期ロイヤリティ・MG消化額・実支払額を計算する
 *
 * 対応する計算タイプ:
 *   製造数量ベース: 製造数 × MSRP × 料率
 *   売上高ベース:   売上高 × 料率
 *   サブライセンス: 受領額 × 分配率
 *   固定額:         契約で定めた固定額（MG充当処理のみ）
 */
import { addDays, formatDateJa, formatDateRaw, parseDateRaw } from "../payments/schedule";
import { calculatePaymentBreakdown } from "../payments/tax";
import { calculatePerformanceCompensation } from "../payments/performance";

// ================================================================
// 型定義
// ================================================================

/** 個別利用許諾条件書から取得するロイヤリティ条件 */
export interface LicenseCondition {
  licenseIssueKey: string;       // ライセンス課題キー (例: LEGAL-10)
  ledgerId: string;              // 台帳ID (例: LIC-ARC-DOM-202604001)
  licensee: string;              // ライセンシー名
  licensor: string;              // ライセンサー名
  originalWork: string;          // 原著作物名

  calcType: RoyaltyCalcType;     // 計算タイプ
  royaltyRate: number;           // 料率 (例: 0.08 = 8%)
  basePrice?: number;            // 基準価格（製造数量ベースの場合のデフォルトMSRP）
  distributionRate?: number;     // 分配率（サブライセンスの場合）
  fixedAmount?: number;          // 固定額（固定額タイプの場合）

  mgAmount: number;              // MG（最低保証金）総額 (0=なし)
  mgConsumedToDate: number;      // 既存の累積消化済みMG額

  paymentCycle: PaymentCycle;    // 支払サイクル
  reportingDaysAfterEvent: number; // イベント後報告期限（日数）
  paymentDaysAfterReport: number;  // 報告後支払期限（日数）

  currency: string;              // 通貨 (JPY / USD 等)
}

/** 製造案件から取得するイベントデータ */
export interface ManufacturingEvent {
  manufacturingIssueKey: string; // 製造課題キー (例: LEGAL-25)
  productName: string;           // 製品名
  edition: string;               // 版 (例: 第3刷)
  completionDate: string;        // 製造完了日 (YYYY-MM-DD)
  quantity: number;              // 製造数量
  msrp: number;                  // MSRP（希望小売価格・税抜）
  currency: string;              // 通貨
  sampleQuantity?: number;       // 販促サンプル数（計算対象外）
  notes?: string;                // 備考
}

/** 計算結果 */
export interface RoyaltyCalculationResult {
  // 入力情報
  licenseIssueKey: string;
  manufacturingIssueKey: string;
  ledgerId: string;
  licensor: string;
  licensee: string;
  originalWork: string;
  productName: string;
  edition: string;

  // 製造情報
  completionDate: string;        // 表示用 (YYYY年MM月DD日)
  completionDateRaw: string;
  quantity: number;              // 製造数量（計算対象）
  sampleQuantity: number;        // サンプル数（対象外）
  billableQuantity: number;      // 課税対象数量（quantity - sampleQuantity）
  msrp: number;
  msrpStr: string;               // 表示用（カンマ区切り）

  // ロイヤリティ計算
  calcType: RoyaltyCalcType;
  royaltyRate: number;
  royaltyRatePct: string;        // 表示用 "8%"
  grossRoyalty: number;          // 計算上のロイヤリティ額（税抜）
  grossRoyaltyStr: string;

  // MG処理
  mgAmount: number;              // MG総額
  mgConsumedBefore: number;      // 今回処理前の消化額
  mgConsumedThisTime: number;    // 今回消化額
  mgConsumedAfter: number;       // 今回処理後の累積消化額
  mgRemaining: number;           // MG残高
  mgFullyConsumed: boolean;      // MG完全消化済みか

  // 実支払額
  actualRoyalty: number;         // 実際の支払額（MG控除後）
  actualRoyaltyStr: string;
  taxRate: number;               // 消費税率
  taxAmount: number;
  totalPayment: number;          // 税込合計
  totalPaymentStr: string;

  // 日程
  calculationBaseDate: string;   // 計算起点日（表示用）
  calculationBaseDateRaw: string;
  reportingDeadline: string;     // 報告期限（表示用）
  reportingDeadlineRaw: string;
  paymentDueDate: string;        // 支払期日（表示用）
  paymentDueDateRaw: string;
  paymentConditionSummary: string;

  // メタ
  currency: string;
  generatedAt: string;
  documentDate: string;
  notes: string;
}

export type RoyaltyCalcType =
  | "manufacturing"   // 製造数量ベース
  | "sales"           // 売上高ベース
  | "sublicense"      // サブライセンス分配
  | "fixed";          // 固定額

export type PaymentCycle =
  | "event"           // イベント都度
  | "monthly"         // 月次
  | "quarterly"       // 四半期
  | "semi_annual"     // 半期
  | "annual";         // 年次

// ================================================================
// メイン計算関数
// ================================================================

/**
 * ロイヤリティを計算する
 */
export function calculateRoyalty(
  license: LicenseCondition,
  event: ManufacturingEvent,
  taxRate = 10
): RoyaltyCalculationResult {

  const completionDate = parseDateRaw(event.completionDate);
  const sampleQty = event.sampleQuantity ?? 0;
  const billableQty = Math.max(0, event.quantity - sampleQty);

  const performanceResult = calculatePerformanceCompensation({
    calcType: license.calcType,
    baseAmount: event.msrp,
    quantity: billableQty,
    rate: license.royaltyRate,
    distributionRate: license.distributionRate ?? 0.5,
    fixedAmount: license.fixedAmount,
  });
  const grossRoyalty = performanceResult.grossAmount;

  // ---- MG処理 ----
  const mgAmount = license.mgAmount;
  const mgConsumedBefore = license.mgConsumedToDate;
  const mgRemaining = Math.max(0, mgAmount - mgConsumedBefore);

  let actualRoyalty: number;
  let mgConsumedThisTime: number;

  if (mgAmount === 0) {
    // MGなし → グロスがそのまま実支払額
    actualRoyalty = grossRoyalty;
    mgConsumedThisTime = 0;
  } else if (mgRemaining === 0) {
    // MG完全消化済み → 全額支払
    actualRoyalty = grossRoyalty;
    mgConsumedThisTime = 0;
  } else if (grossRoyalty <= mgRemaining) {
    // 今回のロイヤリティでMGを消化しきれない → 今回の実払いはゼロ
    actualRoyalty = 0;
    mgConsumedThisTime = grossRoyalty;
  } else {
    // MGを超過した分のみ実払い
    actualRoyalty = grossRoyalty - mgRemaining;
    mgConsumedThisTime = mgRemaining;
  }

  const mgConsumedAfter = mgConsumedBefore + mgConsumedThisTime;
  const mgFullyConsumed = mgAmount > 0 && mgConsumedAfter >= mgAmount;

  // ---- 消費税計算 ----
  const paymentBreakdown = calculatePaymentBreakdown({
    amountExTax: actualRoyalty,
    consumptionTaxRate: taxRate,
  });
  const taxAmount = paymentBreakdown.consumptionTaxAmount;
  const totalPayment = paymentBreakdown.totalWithTax;

  // ---- 日程計算 ----
  const calculationBaseDateObj = resolveRoyaltyCalculationBaseDate(completionDate, license.paymentCycle);
  const reportingDeadlineDate = addDays(calculationBaseDateObj, license.reportingDaysAfterEvent);
  const paymentDueDateObj = addDays(reportingDeadlineDate, license.paymentDaysAfterReport);

  const paymentConditionSummary = buildPaymentSummary(license);

  return {
    licenseIssueKey: license.licenseIssueKey,
    manufacturingIssueKey: event.manufacturingIssueKey,
    ledgerId: license.ledgerId,
    licensor: license.licensor,
    licensee: license.licensee,
    originalWork: license.originalWork,
    productName: event.productName,
    edition: event.edition,

    completionDate: formatDateJa(completionDate),
    completionDateRaw: event.completionDate,
    quantity: event.quantity,
    sampleQuantity: sampleQty,
    billableQuantity: billableQty,
    msrp: event.msrp,
    msrpStr: formatMoney(event.msrp),

    calcType: license.calcType,
    royaltyRate: license.royaltyRate,
    royaltyRatePct: `${Math.round(license.royaltyRate * 100)}%`,
    grossRoyalty,
    grossRoyaltyStr: formatMoney(grossRoyalty),

    mgAmount,
    mgConsumedBefore,
    mgConsumedThisTime,
    mgConsumedAfter,
    mgRemaining: Math.max(0, mgAmount - mgConsumedAfter),
    mgFullyConsumed,

    actualRoyalty,
    actualRoyaltyStr: formatMoney(actualRoyalty),
    taxRate,
    taxAmount,
    totalPayment,
    totalPaymentStr: formatMoney(totalPayment),

    calculationBaseDate: formatDateJa(calculationBaseDateObj),
    calculationBaseDateRaw: formatDateRaw(calculationBaseDateObj),
    reportingDeadline: formatDateJa(reportingDeadlineDate),
    reportingDeadlineRaw: formatDateRaw(reportingDeadlineDate),
    paymentDueDate: formatDateJa(paymentDueDateObj),
    paymentDueDateRaw: formatDateRaw(paymentDueDateObj),
    paymentConditionSummary,

    currency: license.currency,
    generatedAt: new Date().toLocaleString("ja-JP"),
    documentDate: formatDateJa(new Date()),
    notes: event.notes ?? "",
  };
}

function formatMoney(n: number): string {
  return n.toLocaleString("ja-JP");
}

function buildPaymentSummary(license: LicenseCondition): string {
  const cycleMap: Record<PaymentCycle, string> = {
    event: "製造完了都度",
    monthly: "月次",
    quarterly: "四半期",
    semi_annual: "半期",
    annual: "年次",
  };
  const baseMap: Record<PaymentCycle, string> = {
    event: "製造完了日",
    monthly: "月末締め日",
    quarterly: "四半期末締め日",
    semi_annual: "半期末締め日",
    annual: "年末締め日",
  };
  return `${cycleMap[license.paymentCycle]}｜${baseMap[license.paymentCycle]}後${license.reportingDaysAfterEvent}日以内に報告、報告後${license.paymentDaysAfterReport}日以内に支払`;
}

function resolveRoyaltyCalculationBaseDate(completionDate: Date, paymentCycle: PaymentCycle): Date {
  const date = new Date(completionDate);
  if (paymentCycle === "event") {
    return date;
  }
  if (paymentCycle === "monthly") {
    return endOfMonth(date.getFullYear(), date.getMonth());
  }
  if (paymentCycle === "quarterly") {
    const quarterEndMonth = Math.floor(date.getMonth() / 3) * 3 + 2;
    return endOfMonth(date.getFullYear(), quarterEndMonth);
  }
  if (paymentCycle === "semi_annual") {
    const halfEndMonth = date.getMonth() < 6 ? 5 : 11;
    return endOfMonth(date.getFullYear(), halfEndMonth);
  }
  return endOfMonth(date.getFullYear(), 11);
}

function endOfMonth(year: number, monthIndex: number): Date {
  return new Date(year, monthIndex + 1, 0);
}
