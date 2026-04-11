/**
 * src/documents/partialDeliveryGenerator.ts
 * 分割納品対応の検収書・支払通知書 生成モジュール
 *
 * 使用テンプレート（添付ファイルを正とする）:
 *   検収書:    templates/template_inspection_report.html
 *   支払通知:  templates/template_payment_notice_actual.html
 *
 * DBのDeliveryEvent + OrderItem + ChangeLog を正テンプレートの変数形式に
 * マッピングして生成する。
 */

import { renderTemplate, formatDateJa, formatMoneyStr } from "./templateRenderer";
import {
  getDeliveryEventWithContext,
  getOrderSummary,
  passInspection,
  updateDeliveryEventDocuments,
} from "../db/orderRepository";
import { findVendorByCode } from "../db/repository";
import { resolveConditions } from "./conditions";
import { calculatePaymentByMethod } from "../payments/methods";

// ================================================================
// 型定義
// ================================================================

export interface DeliveryGenOptions {
  deliveryEventId: string;
  inspectedAt?: Date;

  // 支払条件（LegalRequestのカスタムフィールドから取得）
  paymentCondition: {
    closingDay: string;          // 末日 / 15 / 20 etc.
    paymentMonthOffset: string;  // 1 = 翌月, 2 = 翌々月
    paymentDay: string;          // 末日 / 25 etc.
    inspectionDays: number;      // 検収期間（日数）
    taxRate: number;             // 消費税率 (10)
  };

  // 検収承認者情報（省略可）
  approver?: {
    name: string;
    department?: string;
  };
  reviewer?: {
    name: string;
    department?: string;
  };
  person?: {
    name: string;
    department?: string;
  };

  // 仕入先の適格請求書登録番号（省略可）
  vendorInvoiceNum?: string;
}

export interface DeliveryGenResult {
  inspectionCert: { filename: string; localPath: string; driveUrl?: string };
  paymentNotice?: { filename: string; localPath: string; driveUrl?: string };
}

// ================================================================
// メイン生成関数
// ================================================================

export async function generateDeliveryDocuments(
  opts: DeliveryGenOptions
): Promise<DeliveryGenResult> {

  // ---- DBからコンテキストを取得 ----
  const event = await getDeliveryEventWithContext(opts.deliveryEventId);
  if (!event) throw new Error(`DeliveryEvent not found: ${opts.deliveryEventId}`);

  const orderItem  = event.orderItem;
  const request    = orderItem.legalRequest;
  const summary    = await getOrderSummary(request.id);
  const { paymentCondition: pc } = opts;
  const vendor = orderItem.vendorCode ? await findVendorByCode(orderItem.vendorCode) : null;
  const vendorRepresentative = vendor?.vendorRepresentative ?? vendor?.contactName ?? "";
  const inspectionApprovedAt = opts.inspectedAt ?? event.inspectedAt ?? event.deliveredAt;

  // ---- 金額計算 ----
  const deliveredAmount = event.deliveredAmount ?? orderItem.latestAmount;
  const paymentCalculation = calculatePaymentByMethod({
    paymentMethod: orderItem.payMethod ?? "lump_sum",
    amountExTax: deliveredAmount,
    consumptionTaxRate: pc.taxRate,
    useJapaneseGeneralWithholding: Boolean(vendor?.withholdingEnabled && vendor?.entityType === "individual"),
    installmentCount: orderItem.installmentCount ?? undefined,
    firstPaymentDate: orderItem.paymentStartDate ?? undefined,
    monthInterval: orderItem.paymentIntervalMonths ?? undefined,
    subscriptionMonths: orderItem.subscriptionMonths ?? undefined,
  });
  const paymentBreakdown = paymentCalculation.breakdown;
  const taxAmount       = paymentBreakdown.consumptionTaxAmount;
  const totalIncTax     = paymentBreakdown.totalWithTax;
  const totalExTax      = paymentBreakdown.amountExTax;

  // ---- 支払期日を計算（conditions.ts のロジックを流用） ----
  const deliveredDateStr = event.deliveredAt.toISOString().slice(0, 10);
  const resolved = resolveConditions({
    issueKey:          request.backlogIssueKey,
    orderTitle:        request.summary,
    counterparty:      request.counterparty,
    orderDate:         request.createdAt.toISOString().slice(0, 10),
    orderAmount:       String(deliveredAmount),
    taxRate:           String(pc.taxRate),
    deliveryDate:      deliveredDateStr,
    description:       orderItem.description,
    closingType:       "monthly",
    closingDay:        pc.closingDay,
    paymentMonthOffset: pc.paymentMonthOffset,
    paymentDay:        pc.paymentDay,
    inspectionDays:    String(pc.inspectionDays),
    inspectionStartFrom: "delivery",
  });

  // ---- ChangeLog を検収書用に整形 ----
  // 金額変更: fieldName = "amount" の最初の ChangeLog を使用
  const amountChange = orderItem.changeLogs.find(l => l.fieldName === "amount");
  // 修正（仕様・成果物名変更）: fieldName = "description" or "spec"
  const specChange = orderItem.changeLogs.find(
    l => l.fieldName === "description" || l.fieldName === "spec"
  );

  // ---- 分割納品の状況判定 ----
  const allDeliveries   = orderItem.deliveryEvents;
  const isPartialDelivery = allDeliveries.length > 1
    || (event.deliveredAmount !== null && event.deliveredAmount < orderItem.latestAmount);
  const isFinalDelivery = !isPartialDelivery
    || summary.pendingAmount - deliveredAmount <= 0;

  // ---- delivery_id の生成（検収書No） ----
  // 例: LEGAL-30-①1-2回目
  const deliveryId = `${request.backlogIssueKey}-①${orderItem.itemNo}-${event.deliveryNo}`;

  // ================================================================
  // 1. 検収書を生成（template_inspection_report.html）
  // ================================================================

  const inspectionVars: Record<string, unknown> = {
    // ヘッダー
    delivery_id:      deliveryId,
    vendor_name:      vendor?.vendorName ?? request.counterparty,
    vendor_representative: vendorRepresentative,
    vendor_representative_sama: vendorRepresentative ? `${vendorRepresentative} 様` : "",
    vendor_invoice_num: vendor?.invoiceRegistrationNumber ?? opts.vendorInvoiceNum ?? "",

    // 発注情報
    order_no:         request.backlogIssueKey,
    contract_no:      "",               // 基本契約番号（あれば設定）
    project_name:     request.summary,

    // 明細行（items配列）
    items: [{
      inspection_date:  inspectionApprovedAt,
      name:             orderItem.description,
      order_no:         request.backlogIssueKey,
      spec:             orderItem.spec ?? "",
      no:               `①${orderItem.itemNo}`,

      // 数量・金額
      thisTimeQuantity: 1,
      amount_ex_tax:    deliveredAmount,

      // 金額変更履歴
      hasAmountChange:   !!amountChange,
      originalAmount:    amountChange ? parseInt(amountChange.beforeValue, 10) : 0,
      newAmount:         amountChange ? parseInt(amountChange.afterValue, 10)  : 0,
      amountChangeReason: amountChange?.reason ?? "",

      // 仕様・成果物名変更
      hasRevision:      !!specChange,
      revisionDetail:   specChange
        ? `${specChange.fieldName === "description" ? "成果物名" : "仕様"}変更: ${specChange.beforeValue} → ${specChange.afterValue}（理由: ${specChange.reason}）`
        : "",

      // 納品種別・分割状況
      isCompleted:       isFinalDelivery,
      partial_number:    isPartialDelivery ? event.deliveryNo  : null,
      total_partials:    isPartialDelivery ? allDeliveries.length : null,
      is_final_delivery: isFinalDelivery,

      // マイルストーン・URL
      milestone_name:   "",
      delivery_url:     "",   // Drive URLは生成後に更新

      // 備考
      notes: event.note ?? "",
    }],

    // 合計
    totalExTax:   totalExTax,
    totalIncTax:  totalIncTax,

    // 承認欄
    approver_name:       opts.approver?.name ?? "",
    approver_department: opts.approver?.department ?? "",
    reviewer_name:       opts.reviewer?.name ?? "",
    reviewer_department: opts.reviewer?.department ?? "",
    person_name:         opts.person?.name ?? (process.env.LEGAL_STAFF_NAME ?? ""),
    person_department:   opts.person?.department ?? "法務部",

    // 承認日・コメント
    approval_date:      inspectionApprovedAt,
    approval_comments:  "",

    // 納品種別ラベル
    deliveryTypeLabel:  isPartialDelivery ? "一部納品" : "全部納品",
    business_description: orderItem.description,   // items未使用時のフォールバック
  };

  const certBasename = `${request.backlogIssueKey}_①${orderItem.itemNo}_第${event.deliveryNo}回_検収書`;
  const inspectionCert = await renderTemplate({
    templateKey:    "inspection",
    variables:      inspectionVars,
    outputBasename: certBasename,
    driveFolderKey: request.driveFolderKey ?? undefined,
  });

  // 検収完了をDBに記録
  await passInspection(opts.deliveryEventId, inspectionCert.driveUrl, inspectionApprovedAt);

  const result: DeliveryGenResult = { inspectionCert };

  // ================================================================
  // 2. 支払通知書を生成（template_payment_notice_actual.html）
  //    最終納品時のみ発行
  // ================================================================

  if (isFinalDelivery) {
    const paymentVars: Record<string, unknown> = {
      // ヘッダー
      notice_id:    `PAY-${deliveryId}`,
      notice_date:  formatDateJa(new Date()),

      // 宛先
      vendor_name:       request.counterparty,
      vendor_representative: vendorRepresentative,
      vendor_representative_sama: vendorRepresentative ? `${vendorRepresentative} 様` : "",
      vendorSuffix:      vendor?.vendorSuffix ?? "御中",
      vendor_invoice_num: vendor?.invoiceRegistrationNumber ?? opts.vendorInvoiceNum ?? "",

      // 発行者（ARCLIGHT_DEFAULTSで注入されるが明示）
      STAFF_NAME:         process.env.LEGAL_STAFF_NAME ?? "",

      // 金額
      totalWithTax:    totalIncTax,
      expenseAmount:   null,
      withholdingTax:  paymentBreakdown.withholdingTaxAmount || null,
      paymentAmount:   paymentBreakdown.paymentAmount,
      showWithholdingNote: paymentBreakdown.withholdingTaxAmount > 0,
      withholdingRateLabel: paymentBreakdown.withholdingTaxAmount > 0 ? "法定税率" : "",

      // 明細行
      items: [{
        order_no: deliveryId,
        name:     `${orderItem.description}（${request.backlogIssueKey} ①${orderItem.itemNo}）`,
        detail:   orderItem.spec ?? "",
        amount:   totalIncTax,
      }],

      // 支払情報
      payment_due_date: resolved.paymentDueDate,

      // 振込先（.envまたはBacklogフィールドから取得）
      BANK_NAME:         vendor?.bankName ?? process.env.PAYMENT_BANK_NAME ?? "",
      BRANCH_NAME:       vendor?.branchName ?? process.env.PAYMENT_BRANCH_NAME ?? "",
      ACCOUNT_TYPE:      vendor?.accountType ?? process.env.PAYMENT_ACCOUNT_TYPE ?? "普通",
      ACCOUNT_NUMBER:    vendor?.accountNumber ?? process.env.PAYMENT_ACCOUNT_NO ?? "",
      BANK_ACCOUNT_NAME: vendor?.accountHolderKana ?? process.env.PAYMENT_ACCOUNT_NAME ?? "",
    };

    const noticeBasename = `${request.backlogIssueKey}_①${orderItem.itemNo}_支払通知書`;
    result.paymentNotice = await renderTemplate({
      templateKey:    "payment_notice",
      variables:      paymentVars,
      outputBasename: noticeBasename,
      driveFolderKey: request.driveFolderKey ?? undefined,
    });
  }

  await updateDeliveryEventDocuments(opts.deliveryEventId, {
    inspectionCertUrl: inspectionCert.driveUrl,
    paymentNoticeUrl: result.paymentNotice?.driveUrl,
  });

  return result;
}
