export type PerformanceCalcType =
  | "manufacturing"
  | "sales"
  | "sublicense"
  | "fixed";

export interface PerformanceCalculationInput {
  calcType: PerformanceCalcType;
  baseAmount?: number;
  quantity?: number;
  rate?: number;
  distributionRate?: number;
  fixedAmount?: number;
}

export interface PerformanceCalculationResult {
  calcType: PerformanceCalcType;
  grossAmount: number;
  baseAmount: number;
  quantity: number;
  rate: number;
  distributionRate: number;
  fixedAmount: number;
}

export interface LicenseMoneyConditionInput {
  heading?: string;
  calcMethod?: string;
  formula?: string;
  basePriceLabel?: string;
  rateLabel?: string;
  shareRateLabel?: string;
  paymentTerms?: string;
  mgAgLabel?: string;
  summary?: string;
  region?: string;
  language?: string;
}

export interface LicenseMoneyConditionSummary {
  heading: string;
  calcType: PerformanceCalcType;
  calcTypeLabel: string;
  formula: string;
  paymentTerms: string;
  parsedRate?: number;
  parsedDistributionRate?: number;
  parsedFixedAmount?: number;
  parsedMgAmount?: number;
  requiresBaseAmount: boolean;
  requiresQuantity: boolean;
  regionLanguage: string;
}

export function calculatePerformanceCompensation(input: PerformanceCalculationInput): PerformanceCalculationResult {
  const calcType = input.calcType;
  const baseAmount = Math.max(0, Math.floor(input.baseAmount ?? 0));
  const quantity = Math.max(0, Math.floor(input.quantity ?? 0));
  const rate = normalizeDecimal(input.rate);
  const distributionRate = normalizeDecimal(input.distributionRate);
  const fixedAmount = Math.max(0, Math.floor(input.fixedAmount ?? 0));

  let grossAmount = 0;
  if (calcType === "manufacturing") {
    grossAmount = Math.floor(quantity * baseAmount * rate);
  } else if (calcType === "sales") {
    grossAmount = Math.floor(baseAmount * rate);
  } else if (calcType === "sublicense") {
    grossAmount = Math.floor(baseAmount * distributionRate);
  } else {
    grossAmount = fixedAmount;
  }

  return {
    calcType,
    grossAmount,
    baseAmount,
    quantity,
    rate,
    distributionRate,
    fixedAmount,
  };
}

export function inferPerformanceCalcType(...values: Array<string | undefined>): PerformanceCalcType {
  const text = values.map((value) => String(value ?? "").toLowerCase()).join(" ");
  if (/(固定|fixed)/.test(text)) return "fixed";
  if (/(サブライセンス|sublicense|分配|distribution|受領額)/.test(text)) return "sublicense";
  if (/(売上|sales|正味売上|net sales)/.test(text)) return "sales";
  return "manufacturing";
}

export function summarizeLicenseMoneyCondition(input: LicenseMoneyConditionInput): LicenseMoneyConditionSummary {
  const calcType = inferPerformanceCalcType(input.calcMethod, input.formula, input.summary, input.basePriceLabel);
  const parsedRate = parseRateText(input.rateLabel);
  const parsedDistributionRate = parseRateText(input.shareRateLabel);
  const parsedFixedAmount = calcType === "fixed" ? parseMoneyText(input.rateLabel || input.summary) : undefined;
  const parsedMgAmount = parseMoneyText(input.mgAgLabel);

  return {
    heading: String(input.heading ?? "").trim() || "未設定",
    calcType,
    calcTypeLabel: getPerformanceCalcTypeLabel(calcType),
    formula: String(input.formula ?? input.summary ?? "").trim(),
    paymentTerms: String(input.paymentTerms ?? "").trim(),
    parsedRate: parsedRate ?? undefined,
    parsedDistributionRate: parsedDistributionRate ?? undefined,
    parsedFixedAmount: parsedFixedAmount ?? undefined,
    parsedMgAmount: parsedMgAmount ?? undefined,
    requiresBaseAmount: calcType !== "fixed",
    requiresQuantity: calcType === "manufacturing",
    regionLanguage: [String(input.region ?? "").trim(), String(input.language ?? "").trim()].filter(Boolean).join(" / "),
  };
}

export function getPerformanceCalcTypeLabel(calcType: PerformanceCalcType): string {
  if (calcType === "manufacturing") return "数量×基準価格×料率";
  if (calcType === "sales") return "基準価格×料率";
  if (calcType === "sublicense") return "受領額×分配率";
  return "固定額";
}

export function parseRateText(value: string | undefined): number | undefined {
  const text = String(value ?? "").trim();
  if (!text) return undefined;
  const match = text.match(/(-?\d+(?:\.\d+)?)\s*%/);
  if (match) {
    return Number(match[1]) / 100;
  }
  const numeric = Number(text.replace(/[,\s]/g, ""));
  if (!Number.isFinite(numeric)) return undefined;
  if (numeric > 1) {
    return numeric / 100;
  }
  return numeric;
}

export function parseMoneyText(value: string | undefined): number | undefined {
  const text = String(value ?? "").replace(/[¥,\s，]/g, "").trim();
  if (!text) return undefined;
  const match = text.match(/-?\d+(?:\.\d+)?/);
  if (!match) return undefined;
  const numeric = Number(match[0]);
  if (!Number.isFinite(numeric)) return undefined;
  return Math.floor(numeric);
}

function normalizeDecimal(value: number | undefined): number {
  if (!Number.isFinite(value ?? NaN)) return 0;
  return Math.max(0, Number(value));
}
