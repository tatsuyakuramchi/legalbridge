export interface PaymentBreakdownInput {
  amountExTax: number;
  consumptionTaxRate: number;
  withholdingRate?: number;
  withholdingBaseAmount?: number;
  useJapaneseGeneralWithholding?: boolean;
}

export interface PaymentBreakdown {
  amountExTax: number;
  consumptionTaxRate: number;
  consumptionTaxAmount: number;
  totalWithTax: number;
  withholdingRate: number;
  withholdingBaseAmount: number;
  withholdingTaxAmount: number;
  paymentAmount: number;
}

export function roundTaxDown(value: number): number {
  return Math.floor(value);
}

export function calculateConsumptionTax(amountExTax: number, taxRate: number): number {
  return roundTaxDown(amountExTax * taxRate / 100);
}

export function calculateWithholdingTax(baseAmount: number, withholdingRate: number): number {
  if (withholdingRate <= 0 || baseAmount <= 0) {
    return 0;
  }
  return roundTaxDown(baseAmount * withholdingRate / 100);
}

export function calculatePaymentBreakdown(input: PaymentBreakdownInput): PaymentBreakdown {
  const amountExTax = Math.max(0, input.amountExTax);
  const withholdingRate = Math.max(0, input.withholdingRate ?? 0);
  const consumptionTaxAmount = calculateConsumptionTax(amountExTax, input.consumptionTaxRate);
  const totalWithTax = amountExTax + consumptionTaxAmount;
  const withholdingBaseAmount = Math.max(0, input.withholdingBaseAmount ?? totalWithTax);
  const withholdingTaxAmount = input.useJapaneseGeneralWithholding
    ? calculateJapaneseGeneralWithholdingTax(withholdingBaseAmount)
    : calculateWithholdingTax(withholdingBaseAmount, withholdingRate);
  const paymentAmount = totalWithTax - withholdingTaxAmount;

  return {
    amountExTax,
    consumptionTaxRate: input.consumptionTaxRate,
    consumptionTaxAmount,
    totalWithTax,
    withholdingRate,
    withholdingBaseAmount,
    withholdingTaxAmount,
    paymentAmount,
  };
}

export function calculateJapaneseGeneralWithholdingTax(amountIncludingTax: number): number {
  const base = Math.max(0, amountIncludingTax);
  if (base <= 1_000_000) {
    return Math.floor(base * 0.1021);
  }
  return Math.floor(102_100 + ((base - 1_000_000) * 0.2042));
}
