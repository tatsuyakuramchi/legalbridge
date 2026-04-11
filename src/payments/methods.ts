import { calculatePaymentBreakdown, PaymentBreakdown } from "./tax";
import { calculatePerformanceCompensation, PerformanceCalcType } from "./performance";

export type PaymentMethodCode =
  | "lump_sum"
  | "installment"
  | "subscription"
  | "performance";

export interface PaymentMethodOption {
  code: PaymentMethodCode;
  label: string;
}

export const PAYMENT_METHOD_OPTIONS: PaymentMethodOption[] = [
  { code: "lump_sum", label: "一括" },
  { code: "installment", label: "分割" },
  { code: "subscription", label: "サブスク" },
  { code: "performance", label: "業績連動" },
];

const PAYMENT_METHOD_ALIASES: Record<string, PaymentMethodCode> = {
  lump_sum: "lump_sum",
  installment: "installment",
  subscription: "subscription",
  performance: "performance",
  "一括": "lump_sum",
  "一括払い": "lump_sum",
  "分割": "installment",
  "分割払い": "installment",
  "サブスク": "subscription",
  "サブスクリプション": "subscription",
  "業績連動": "performance",
  "出来高払い": "performance",
};

export interface PaymentCalculationInput {
  paymentMethod: PaymentMethodCode | string;
  amountExTax: number;
  consumptionTaxRate: number;
  useJapaneseGeneralWithholding?: boolean;
  installmentCount?: number;
  firstPaymentDate?: string | Date;
  paymentDay?: number;
  monthInterval?: number;
  subscriptionMonths?: number;
  performanceCalcType?: PerformanceCalcType;
  performanceBaseAmount?: number;
  performanceQuantity?: number;
  performanceRate?: number;
  performanceDistributionRate?: number;
  performanceFixedAmount?: number;
}

export interface PaymentScheduleEntry {
  index: number;
  label: string;
  dueDate?: string;
  breakdown: PaymentBreakdown;
}

export interface PaymentCalculationResult {
  paymentMethod: PaymentMethodCode;
  paymentMethodLabel: string;
  scheduleKind: "single" | "split" | "recurring" | "performance";
  breakdown: PaymentBreakdown;
  schedule: PaymentScheduleEntry[];
  warnings: string[];
}

export function normalizePaymentMethodCode(value: unknown): PaymentMethodCode {
  const text = String(value ?? "").trim();
  return PAYMENT_METHOD_ALIASES[text] ?? "lump_sum";
}

export function getPaymentMethodLabel(code: PaymentMethodCode): string {
  return PAYMENT_METHOD_OPTIONS.find((option) => option.code === code)?.label ?? "一括";
}

export function calculatePaymentByMethod(input: PaymentCalculationInput): PaymentCalculationResult {
  const paymentMethod = normalizePaymentMethodCode(input.paymentMethod);
  const warnings: string[] = [];
  const amountExTax = resolveBaseAmountExTax(paymentMethod, input, warnings);
  const scheduleKind = resolveScheduleKind(paymentMethod);
  const scheduleCount = resolveScheduleCount(paymentMethod, input, warnings);
  const splitAmounts = splitAmount(amountExTax, scheduleCount);
  const dueDates = buildDueDates(paymentMethod, scheduleCount, input, warnings);
  const schedule = splitAmounts.map((splitAmountExTax, index) => ({
    index: index + 1,
    label: buildScheduleLabel(paymentMethod, index + 1, scheduleCount),
    dueDate: dueDates[index],
    breakdown: calculatePaymentBreakdown({
      amountExTax: splitAmountExTax,
      consumptionTaxRate: input.consumptionTaxRate,
      useJapaneseGeneralWithholding: input.useJapaneseGeneralWithholding,
    }),
  }));
  const breakdown = mergeScheduleBreakdown(schedule, input.consumptionTaxRate);

  return {
    paymentMethod,
    paymentMethodLabel: getPaymentMethodLabel(paymentMethod),
    scheduleKind,
    breakdown,
    schedule,
    warnings,
  };
}

function resolveBaseAmountExTax(
  paymentMethod: PaymentMethodCode,
  input: PaymentCalculationInput,
  warnings: string[]
): number {
  if (paymentMethod !== "performance") {
    return Math.max(0, input.amountExTax);
  }

  const hasPerformanceInput = [
    input.performanceBaseAmount,
    input.performanceQuantity,
    input.performanceRate,
    input.performanceDistributionRate,
    input.performanceFixedAmount,
  ].some((value) => Number.isFinite(value ?? NaN) && Number(value) > 0);

  if (!hasPerformanceInput) {
    warnings.push("業績連動ですが基準価格・数量・料率などが未指定のため、入力済み金額をそのまま使用しました。");
    return Math.max(0, input.amountExTax);
  }

  const result = calculatePerformanceCompensation({
    calcType: input.performanceCalcType ?? "sales",
    baseAmount: input.performanceBaseAmount,
    quantity: input.performanceQuantity,
    rate: input.performanceRate,
    distributionRate: input.performanceDistributionRate,
    fixedAmount: input.performanceFixedAmount,
  });
  return result.grossAmount;
}

function resolveScheduleKind(paymentMethod: PaymentMethodCode): PaymentCalculationResult["scheduleKind"] {
  if (paymentMethod === "installment") return "split";
  if (paymentMethod === "subscription") return "recurring";
  if (paymentMethod === "performance") return "performance";
  return "single";
}

function resolveScheduleCount(
  paymentMethod: PaymentMethodCode,
  input: PaymentCalculationInput,
  warnings: string[]
): number {
  if (paymentMethod === "installment") {
    const count = normalizePositiveInteger(input.installmentCount);
    if (!count) {
      warnings.push("分割支払ですが分割回数が未指定のため、1回払いとして計算しました。");
      return 1;
    }
    return count;
  }

  if (paymentMethod === "subscription") {
    const months = normalizePositiveInteger(input.subscriptionMonths ?? input.installmentCount);
    if (!months) {
      warnings.push("サブスク支払ですが期間月数が未指定のため、1か月分として計算しました。");
      return 1;
    }
    return months;
  }

  return 1;
}

function buildDueDates(
  paymentMethod: PaymentMethodCode,
  scheduleCount: number,
  input: PaymentCalculationInput,
  warnings: string[]
): Array<string | undefined> {
  if (scheduleCount <= 1) {
    const onlyDate = normalizeDateInput(input.firstPaymentDate, input.paymentDay);
    return [onlyDate];
  }

  const firstPaymentDate = normalizeDateInput(input.firstPaymentDate, input.paymentDay);
  if (!firstPaymentDate) {
    if (paymentMethod === "installment" || paymentMethod === "subscription") {
      warnings.push("支払日の基準日が未指定のため、各回の支払日を設定していません。");
    }
    return Array.from({ length: scheduleCount }, () => undefined);
  }

  const interval = paymentMethod === "subscription"
    ? Math.max(1, input.monthInterval ?? 1)
    : Math.max(1, input.monthInterval ?? 1);
  return Array.from({ length: scheduleCount }, (_, index) => addMonths(firstPaymentDate, index * interval));
}

function buildScheduleLabel(paymentMethod: PaymentMethodCode, index: number, scheduleCount: number): string {
  if (paymentMethod === "installment") {
    return `${index}/${scheduleCount}回目`;
  }
  if (paymentMethod === "subscription") {
    return `${index}か月目`;
  }
  if (paymentMethod === "performance") {
    return "実績確定後";
  }
  return "一括支払";
}

function splitAmount(amount: number, count: number): number[] {
  const normalizedAmount = Math.max(0, Math.floor(amount));
  const normalizedCount = Math.max(1, Math.floor(count));
  const base = Math.floor(normalizedAmount / normalizedCount);
  const remainder = normalizedAmount - (base * normalizedCount);
  return Array.from({ length: normalizedCount }, (_, index) => (
    index === normalizedCount - 1 ? base + remainder : base
  ));
}

function mergeScheduleBreakdown(schedule: PaymentScheduleEntry[], consumptionTaxRate: number): PaymentBreakdown {
  return schedule.reduce<PaymentBreakdown>((acc, entry) => ({
    amountExTax: acc.amountExTax + entry.breakdown.amountExTax,
    consumptionTaxRate,
    consumptionTaxAmount: acc.consumptionTaxAmount + entry.breakdown.consumptionTaxAmount,
    totalWithTax: acc.totalWithTax + entry.breakdown.totalWithTax,
    withholdingRate: acc.withholdingRate,
    withholdingBaseAmount: acc.withholdingBaseAmount + entry.breakdown.withholdingBaseAmount,
    withholdingTaxAmount: acc.withholdingTaxAmount + entry.breakdown.withholdingTaxAmount,
    paymentAmount: acc.paymentAmount + entry.breakdown.paymentAmount,
  }), {
    amountExTax: 0,
    consumptionTaxRate,
    consumptionTaxAmount: 0,
    totalWithTax: 0,
    withholdingRate: 0,
    withholdingBaseAmount: 0,
    withholdingTaxAmount: 0,
    paymentAmount: 0,
  });
}

function normalizePositiveInteger(value: unknown): number | undefined {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

function normalizeDateInput(value: string | Date | undefined, paymentDay?: number): string | undefined {
  if (!value) return undefined;
  const baseDate = value instanceof Date ? new Date(value) : new Date(String(value));
  if (Number.isNaN(baseDate.getTime())) {
    return undefined;
  }
  if (paymentDay && paymentDay >= 1 && paymentDay <= 31) {
    const maxDay = new Date(baseDate.getFullYear(), baseDate.getMonth() + 1, 0).getDate();
    baseDate.setDate(Math.min(paymentDay, maxDay));
  }
  return baseDate.toISOString().slice(0, 10);
}

function addMonths(dateRaw: string, months: number): string {
  const date = new Date(dateRaw);
  const targetDay = date.getDate();
  date.setMonth(date.getMonth() + months, 1);
  const maxDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  date.setDate(Math.min(targetDay, maxDay));
  return date.toISOString().slice(0, 10);
}
