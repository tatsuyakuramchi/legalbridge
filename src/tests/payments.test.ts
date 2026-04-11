import test from "node:test";
import assert from "node:assert/strict";
import { calculatePaymentByMethod, normalizePaymentMethodCode } from "../payments/methods";
import {
  calculatePerformanceCompensation,
  summarizeLicenseMoneyCondition,
} from "../payments/performance";
import { calculateJapaneseGeneralWithholdingTax } from "../payments/tax";
import { calculateRoyalty, LicenseCondition, ManufacturingEvent } from "../documents/royalty";

test("normalizePaymentMethodCode maps legacy labels", () => {
  assert.equal(normalizePaymentMethodCode("一括払い"), "lump_sum");
  assert.equal(normalizePaymentMethodCode("分割払い"), "installment");
  assert.equal(normalizePaymentMethodCode("出来高払い"), "performance");
});

test("installment splits amount and tax per installment", () => {
  const result = calculatePaymentByMethod({
    paymentMethod: "分割",
    amountExTax: 100000,
    consumptionTaxRate: 10,
    installmentCount: 3,
    firstPaymentDate: "2026-05-20",
  });

  assert.equal(result.scheduleKind, "split");
  assert.equal(result.schedule.length, 3);
  assert.deepEqual(
    result.schedule.map((entry) => entry.breakdown.amountExTax),
    [33333, 33333, 33334]
  );
  assert.deepEqual(
    result.schedule.map((entry) => entry.breakdown.consumptionTaxAmount),
    [3333, 3333, 3333]
  );
  assert.deepEqual(
    result.schedule.map((entry) => entry.dueDate),
    ["2026-05-20", "2026-06-20", "2026-07-20"]
  );
  assert.equal(result.breakdown.amountExTax, 100000);
  assert.equal(result.breakdown.totalWithTax, 109999);
});

test("subscription uses month count and monthly due dates", () => {
  const result = calculatePaymentByMethod({
    paymentMethod: "サブスク",
    amountExTax: 120000,
    consumptionTaxRate: 10,
    subscriptionMonths: 4,
    firstPaymentDate: "2026-04-25",
  });

  assert.equal(result.scheduleKind, "recurring");
  assert.equal(result.schedule.length, 4);
  assert.deepEqual(
    result.schedule.map((entry) => entry.dueDate),
    ["2026-04-25", "2026-05-25", "2026-06-25", "2026-07-25"]
  );
  assert.ok(result.warnings.length === 0);
});

test("performance uses royalty-like manufacturing formula", () => {
  const result = calculatePaymentByMethod({
    paymentMethod: "業績連動",
    amountExTax: 0,
    consumptionTaxRate: 10,
    performanceCalcType: "manufacturing",
    performanceBaseAmount: 350,
    performanceQuantity: 1000,
    performanceRate: 0.08,
  });

  assert.equal(result.scheduleKind, "performance");
  assert.equal(result.breakdown.amountExTax, 28000);
  assert.equal(result.breakdown.totalWithTax, 30800);
});

test("performance module supports sublicense and fixed compensation", () => {
  const sublicense = calculatePerformanceCompensation({
    calcType: "sublicense",
    baseAmount: 500000,
    distributionRate: 0.5,
  });
  const fixed = calculatePerformanceCompensation({
    calcType: "fixed",
    fixedAmount: 75000,
  });

  assert.equal(sublicense.grossAmount, 250000);
  assert.equal(fixed.grossAmount, 75000);
});

test("license money condition summary infers royalty-style calculation", () => {
  const summary = summarizeLicenseMoneyCondition({
    heading: "国内販売",
    calcMethod: "製造ベース・MSRP計算",
    formula: "上代（MSRP）× 5.0% × 販売用製造総数",
    rateLabel: "5.0%",
    paymentTerms: "製造月の翌月20日払い",
    mgAgLabel: "MG 100000円",
  });

  assert.equal(summary.calcType, "manufacturing");
  assert.equal(summary.parsedRate, 0.05);
  assert.equal(summary.parsedMgAmount, 100000);
  assert.equal(summary.requiresQuantity, true);
});

test("general withholding tax uses Japanese legal brackets and floor rounding", () => {
  assert.equal(calculateJapaneseGeneralWithholdingTax(100000), 10210);
  assert.equal(calculateJapaneseGeneralWithholdingTax(1000001), 102100);
  assert.equal(calculateJapaneseGeneralWithholdingTax(1500000), 204200);
});

test("royalty event cycle uses completion date as calculation base", () => {
  const result = calculateRoyalty(baseLicenseCondition({ paymentCycle: "event" }), baseManufacturingEvent());
  assert.equal(result.calculationBaseDateRaw, "2026-04-15");
  assert.equal(result.reportingDeadlineRaw, "2026-05-15");
  assert.equal(result.paymentDueDateRaw, "2026-06-14");
});

test("royalty monthly cycle uses month end as calculation base", () => {
  const result = calculateRoyalty(baseLicenseCondition({ paymentCycle: "monthly" }), baseManufacturingEvent());
  assert.equal(result.calculationBaseDateRaw, "2026-04-30");
  assert.equal(result.reportingDeadlineRaw, "2026-05-30");
  assert.equal(result.paymentDueDateRaw, "2026-06-29");
});

test("royalty quarterly cycle uses quarter end as calculation base", () => {
  const result = calculateRoyalty(baseLicenseCondition({ paymentCycle: "quarterly" }), baseManufacturingEvent());
  assert.equal(result.calculationBaseDateRaw, "2026-06-30");
});

function baseLicenseCondition(overrides: Partial<LicenseCondition> = {}): LicenseCondition {
  return {
    licenseIssueKey: "LEGAL-100",
    ledgerId: "LIC-ARC-TEST-202604-001",
    licensee: "株式会社アークライト",
    licensor: "テストライセンサー",
    originalWork: "テスト作品",
    calcType: "manufacturing",
    royaltyRate: 0.08,
    mgAmount: 0,
    mgConsumedToDate: 0,
    paymentCycle: "event",
    reportingDaysAfterEvent: 30,
    paymentDaysAfterReport: 30,
    currency: "JPY",
    ...overrides,
  };
}

function baseManufacturingEvent(overrides: Partial<ManufacturingEvent> = {}): ManufacturingEvent {
  return {
    manufacturingIssueKey: "LEGAL-200",
    productName: "テスト商品",
    edition: "初版",
    completionDate: "2026-04-15",
    quantity: 1000,
    msrp: 350,
    currency: "JPY",
    sampleQuantity: 0,
    notes: "",
    ...overrides,
  };
}
