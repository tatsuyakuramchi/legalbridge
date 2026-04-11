/**
 * documents/conditions.ts
 * 支払条件・検収条件の型定義と日付計算ロジック
 *
 * Backlogカスタムフィールドから取得した文字列を解釈し、
 * 検収書・支払通知書の生成に必要な日付・金額を計算する
 */
import {
  buildPaymentConditionSummary,
  calculateClosingDate,
  calculateInspectionDeadline,
  calculatePaymentDueDate,
  ClosingType,
  formatDateJa,
  formatDateRaw,
  parseDateRaw,
} from "../payments/schedule";
import { calculatePaymentBreakdown } from "../payments/tax";
export type { ClosingType } from "../payments/schedule";

// ================================================================
// 型定義
// ================================================================

/** Backlogカスタムフィールドから取得した生の条件文字列 */
export interface RawConditionFields {
  // --- 発注基本情報 ---
  issueKey: string;
  orderTitle: string;          // 件名
  counterparty: string;        // 相手方名
  orderDate: string;           // 発注日 (YYYY-MM-DD)
  orderAmount: string;         // 発注金額（税抜）文字列 例: "250000"
  taxRate: string;             // 消費税率 例: "10"
  deliveryDate: string;        // 納品予定日 (YYYY-MM-DD)
  description: string;         // 業務内容・品目

  // --- 支払条件 ---
  closingType: ClosingType;    // 締め方式
  closingDay: string;          // 締め日 例: "末日"=0, "15"=15, "20"=20
  paymentMonthOffset: string;  // 支払月オフセット 例: "1"=翌月, "2"=翌々月
  paymentDay: string;          // 支払日 例: "末日"=0, "25"=25

  // --- 検収条件 ---
  inspectionDays: string;      // 検収期間（日数）例: "7"
  inspectionStartFrom: InspectionStart; // 検収起算点
}

/** 支払通知書・検収書の計算済みデータ */
export interface ResolvedConditions {
  // 発注情報
  issueKey: string;
  orderTitle: string;
  counterparty: string;
  orderDate: string;           // 表示用 (YYYY年MM月DD日)
  orderDateRaw: string;        // YYYY-MM-DD
  deliveryDate: string;        // 表示用
  deliveryDateRaw: string;
  description: string;

  // 金額
  orderAmount: number;         // 税抜金額
  taxRate: number;             // 消費税率 (10 or 8)
  taxAmount: number;           // 消費税額
  totalAmount: number;         // 税込合計
  orderAmountStr: string;      // 表示用（カンマ区切り）
  taxAmountStr: string;
  totalAmountStr: string;

  // 検収条件
  inspectionDeadline: string;  // 検収期限（表示用）
  inspectionDeadlineRaw: string;
  inspectionDays: number;

  // 支払条件
  closingDate: string;         // 締め日（表示用）例: "2026年3月31日"
  closingDateRaw: string;
  paymentDueDate: string;      // 支払期日（表示用）
  paymentDueDateRaw: string;
  paymentConditionSummary: string; // 例: "月末締め翌月末払い"

  // メタ
  generatedAt: string;         // 文書生成日時
  documentDate: string;        // 文書日付（表示用）
}

export type InspectionStart = "delivery" | "receipt";  // 納品日起算 | 受領日起算

// ================================================================
// メイン計算関数
// ================================================================

/**
 * Backlogフィールドの生データから計算済み条件を生成する
 */
export function resolveConditions(raw: RawConditionFields): ResolvedConditions {
  const orderDateRaw = raw.orderDate;
  const deliveryDateRaw = raw.deliveryDate;

  // --- 金額計算 ---
  const orderAmount = parseInt(raw.orderAmount.replace(/[,，\s]/g, ""), 10);
  const taxRate = parseInt(raw.taxRate || "10", 10);
  const paymentBreakdown = calculatePaymentBreakdown({
    amountExTax: orderAmount,
    consumptionTaxRate: taxRate,
  });
  const taxAmount = paymentBreakdown.consumptionTaxAmount;
  const totalAmount = paymentBreakdown.totalWithTax;

  // --- 検収期限計算 ---
  const inspectionDays = parseInt(raw.inspectionDays || "7", 10);
  const deliveryDate = parseDateRaw(deliveryDateRaw);
  const inspectionDeadlineDate = calculateInspectionDeadline(deliveryDate, inspectionDays);
  const inspectionDeadlineRaw = formatDateRaw(inspectionDeadlineDate);

  // --- 締め日・支払期日計算 ---
  const closingDayNum = raw.closingDay === "末日" ? 0 : parseInt(raw.closingDay, 10);
  const paymentMonthOffset = parseInt(raw.paymentMonthOffset || "1", 10);
  const paymentDayNum = raw.paymentDay === "末日" ? 0 : parseInt(raw.paymentDay, 10);

  // 検収期限が属する締め期間の締め日を計算
  const closingDate = calculateClosingDate(inspectionDeadlineDate, closingDayNum, raw.closingType);
  // 支払期日 = 締め日の翌月（または翌々月）の支払日
  const paymentDueDate = calculatePaymentDueDate(closingDate, paymentMonthOffset, paymentDayNum);

  const paymentConditionSummary = buildPaymentConditionSummary(
    raw.closingDay, paymentMonthOffset, raw.paymentDay
  );

  const now = new Date();

  return {
    issueKey: raw.issueKey,
    orderTitle: raw.orderTitle,
    counterparty: raw.counterparty,
    orderDate: formatDateJa(parseDateRaw(orderDateRaw)),
    orderDateRaw,
    deliveryDate: formatDateJa(deliveryDate),
    deliveryDateRaw,
    description: raw.description,

    orderAmount,
    taxRate,
    taxAmount,
    totalAmount,
    orderAmountStr: formatMoney(orderAmount),
    taxAmountStr: formatMoney(taxAmount),
    totalAmountStr: formatMoney(totalAmount),

    inspectionDeadline: formatDateJa(inspectionDeadlineDate),
    inspectionDeadlineRaw,
    inspectionDays,

    closingDate: formatDateJa(closingDate),
    closingDateRaw: formatDateRaw(closingDate),
    paymentDueDate: formatDateJa(paymentDueDate),
    paymentDueDateRaw: formatDateRaw(paymentDueDate),
    paymentConditionSummary,

    generatedAt: now.toLocaleString("ja-JP"),
    documentDate: formatDateJa(now),
  };
}

/** 金額をカンマ区切り文字列に変換 */
function formatMoney(n: number): string {
  return n.toLocaleString("ja-JP");
}
