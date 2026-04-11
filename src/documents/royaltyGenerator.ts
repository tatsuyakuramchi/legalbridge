/**
 * documents/royaltyGenerator.ts
 * 製造案件のBacklog課題データから
 * ライセンス条件を逆引きしてロイヤリティを計算・文書化する
 */

import Handlebars from "handlebars";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { google } from "googleapis";
import {
  calculateRoyalty,
  LicenseCondition,
  ManufacturingEvent,
  RoyaltyCalculationResult,
  RoyaltyCalcType,
  PaymentCycle,
} from "./royalty";
import { calculatePaymentBreakdown } from "../payments/tax";
import { backlog } from "../backlog/client";
import { buildRoyaltyDeadlineCustomFields, resolveRoyaltyDeadlines } from "../backlog/deadlines";
import { resolveDriveFolderKey } from "../backlog/issueContext";
import { renderTemplate } from "./templateRenderer";
import {
  findLicenseByBacklogKey,
  findIssueWorkflowByIssueKey,
  findLegalRequestByBacklogKey,
  upsertLicenseContract,
  saveManufacturingEvent,
  incrementMgConsumed,
  updateManufacturingEventUrls,
} from "../db/repository";
import { inferPerformanceCalcType, parseMoneyText, parseRateText } from "../payments/performance";

// Handlebarsカスタムヘルパーを登録
Handlebars.registerHelper("eq", (a: unknown, b: unknown) => a === b);
Handlebars.registerHelper("mgProgressPct", function(this: RoyaltyCalculationResult) {
  if (!this.mgAmount) return 0;
  return Math.min(100, Math.round((this.mgConsumedAfter / this.mgAmount) * 100));
});

const TEMPLATE_DIR = path.resolve(__dirname, "../../templates");
const TMP_DIR = path.resolve(__dirname, "../../tmp");

export interface ResolvedRoyaltyLicenseConditionMeta {
  source: "license_fields" | "license_condition1_fallback";
  calcTypeLabel: string;
  rateSource: string | null;
  mgSource: string | null;
  requestedConditionNo: 1 | 2 | 3;
  resolvedConditionNo: 1 | 2 | 3;
  conditionHeading: string | null;
}

export interface RoyaltyIssueSnapshot {
  issueKey: string;
  issueTypeName: string;
  licenseIssueKey: string;
  requestedConditionNo: 1 | 2 | 3;
  productName: string;
  edition: string;
  completionDate: string;
  quantity: number;
  msrp: number;
  sampleQuantity: number;
  notes: string;
  reportPeriodStart?: string;
  reportPeriodEnd?: string;
  reportingDeadlineRaw?: string;
  paymentDueDateRaw?: string;
  salesAmount?: number;
  receivedAmount?: number;
  salesQuantity?: number;
}

// ================================================================
// Backlog課題フィールドからデータを取得して生成
// ================================================================

/**
 * 製造案件課題のカスタムフィールドを読み取り、
 * ライセンス課題を逆引きして計算・生成する
 */
export async function generateRoyaltyFromManufacturingIssue(
  manufacturingIssueKey: string
): Promise<{ royaltyReport: GeneratedFile; paymentNotice?: GeneratedFile; result: RoyaltyCalculationResult }> {
  return generateRoyaltyFromIssue(manufacturingIssueKey);
}

export async function generateRoyaltyFromIssue(
  issueKey: string
): Promise<{ royaltyReport: GeneratedFile; paymentNotice?: GeneratedFile; result: RoyaltyCalculationResult }> {

  console.log(`[RoyaltyGen] ロイヤリティ対象課題読み込み: ${issueKey}`);

  // 1. 課題を取得
  const issue = await backlog.getIssue(issueKey);
  const snapshot = buildRoyaltyIssueSnapshot(issue);
  const legalRequest = await findLegalRequestByBacklogKey(issueKey);
  const driveFolderKey = resolveDriveFolderKey(legalRequest);

  const licenseIssueKey = snapshot.licenseIssueKey;
  if (!licenseIssueKey) {
    throw new Error(`課題 ${issueKey} に「紐付けライセンス課題キー」が設定されていません`);
  }

  // 2. ライセンス課題を逆引き
  console.log(`[RoyaltyGen] ライセンス課題逆引き: ${licenseIssueKey}`);
  const licIssue = await backlog.getIssue(licenseIssueKey);
  const getLicField = (envKey: string): string =>
    licIssue.customFields?.find(
      (f) => f.fieldId === Number(process.env[envKey])
    )?.value ?? "";
  const licensorRepresentative = getLicField("BACKLOG_FIELD_LICENSOR_REP");

  // 3. LicenseConditionを組み立て
  const { license } = await resolveRoyaltyLicenseCondition(licenseIssueKey, licIssue, snapshot.requestedConditionNo);

  // 4. ManufacturingEvent互換の計算入力を組み立て
  const event: ManufacturingEvent = {
    manufacturingIssueKey: snapshot.issueKey,
    productName: snapshot.productName,
    edition: snapshot.edition,
    completionDate: snapshot.completionDate,
    quantity: snapshot.quantity,
    msrp: snapshot.msrp,
    currency: getLicField("BACKLOG_FIELD_CURRENCY") || "JPY",
    sampleQuantity: snapshot.sampleQuantity,
    notes: snapshot.notes,
  };

  // 5. ロイヤリティ計算
  const result = calculateRoyalty(license, event);
  const resolvedDeadlines = resolveRoyaltyDeadlines(issue, {
    reportingDeadlineRaw: result.reportingDeadlineRaw,
    paymentDueDateRaw: result.paymentDueDateRaw,
  });
  result.reportingDeadlineRaw = resolvedDeadlines.reportingDeadlineRaw;
  result.reportingDeadline = resolvedDeadlines.reportingDeadline;
  result.paymentDueDateRaw = resolvedDeadlines.paymentDueDateRaw;
  result.paymentDueDate = resolvedDeadlines.paymentDueDate;
  console.log(`[RoyaltyGen] 計算完了: グロス¥${result.grossRoyaltyStr} → 実払¥${result.actualRoyaltyStr}`);

  // 5b. DBにライセンス契約を確認・取得（なければBacklogフィールドから作成）
  const existingLicenseRecord = await findLicenseByBacklogKey(licenseIssueKey);
  const shouldSyncLicensePaymentDetails = !existingLicenseRecord
    || !existingLicenseRecord.licensorBankName
    || !existingLicenseRecord.licensorBranchName
    || !existingLicenseRecord.licensorAccountNo
    || !existingLicenseRecord.licensorAccountName
    || !existingLicenseRecord.licensorInvoiceNum;
  const licenseRecord = shouldSyncLicensePaymentDetails
    ? await upsertLicenseContract({
        backlogIssueKey: licenseIssueKey,
        ledgerId: license.ledgerId,
        licensor: license.licensor,
        originalWork: license.originalWork,
        licensorBankName: getLicField("BACKLOG_FIELD_LICENSOR_BANK") || existingLicenseRecord?.licensorBankName || "",
        licensorBranchName: getLicField("BACKLOG_FIELD_LICENSOR_BRANCH") || existingLicenseRecord?.licensorBranchName || "",
        licensorAccountType: getLicField("BACKLOG_FIELD_ACCOUNT_TYPE") || existingLicenseRecord?.licensorAccountType || process.env.PAYMENT_ACCOUNT_TYPE || "普通",
        licensorAccountNo: getLicField("BACKLOG_FIELD_LICENSOR_ACCOUNT_NO") || existingLicenseRecord?.licensorAccountNo || "",
        licensorAccountName: getLicField("BACKLOG_FIELD_LICENSOR_ACCOUNT_NAME") || existingLicenseRecord?.licensorAccountName || "",
        licensorInvoiceNum: getLicField("BACKLOG_FIELD_INVOICE_REGISTRATION_NUMBER") || existingLicenseRecord?.licensorInvoiceNum || "",
        calcType: license.calcType,
        royaltyRate: license.royaltyRate,
        distributionRate: license.distributionRate,
        mgAmount: license.mgAmount,
        paymentCycle: license.paymentCycle,
        reportingDays: license.reportingDaysAfterEvent,
        paymentDays: license.paymentDaysAfterReport,
        currency: license.currency,
      })
    : existingLicenseRecord;
  const licenseRecordId = licenseRecord.id;

  // 5c. 製造イベントと支払記録をDBに保存
  await saveManufacturingEvent(result, licenseRecordId);

  // 5d. MG消化額をDBで累積更新（Backlogフィールドへの書き戻しと二重管理）
  if (result.mgConsumedThisTime > 0) {
    await incrementMgConsumed(licenseRecordId, result.mgConsumedThisTime);
  }

  // 6. MG進捗パーセントをresultに追加（テンプレート用）
  const templateData = {
    ...result,
    VENDOR_REPRESENTATIVE: licensorRepresentative,
    VENDOR_REPRESENTATIVE_SAMA: licensorRepresentative ? `${licensorRepresentative} 様` : "",
    mgProgressPct: license.mgAmount > 0
      ? Math.min(100, Math.round((result.mgConsumedAfter / license.mgAmount) * 100))
      : 0,
    taxAmount: result.taxAmount.toLocaleString("ja-JP"),
  };

  // 7. 利用許諾料計算書を生成
  const royaltyReport = await renderAndSave(
    "royalty_report.html",
    templateData,
    `${snapshot.issueKey}_利用許諾料計算書`,
    driveFolderKey,
  );

  let paymentNotice: GeneratedFile | undefined;
  if (result.totalPayment > 0) {
    paymentNotice = await renderRoyaltyPaymentNotice({
      manufacturingIssueKey: snapshot.issueKey,
      licenseRecord: {
        ...licenseRecord,
        licensorRepresentative,
      },
      result,
      driveFolderKey,
    });
  }

  // 8. ライセンス課題のMG消化額を更新（カスタムフィールドを更新）
  if (result.mgConsumedThisTime > 0) {
    await backlog.updateCustomField(
      licenseIssueKey,
      Number(process.env.BACKLOG_FIELD_MG_CONSUMED),
      String(result.mgConsumedAfter)
    );
    console.log(`[RoyaltyGen] MG消化額更新: ${result.mgConsumedBefore} → ${result.mgConsumedAfter}`);
  }

  await backlog.updateIssue(issue.issueKey, {
    dueDate: resolvedDeadlines.issueDueDateRaw,
    customFields: buildRoyaltyDeadlineCustomFields({
      reportingDeadlineRaw: resolvedDeadlines.reportingDeadlineRaw,
      paymentDueDateRaw: resolvedDeadlines.paymentDueDateRaw,
    }),
  });

  // 9. Drive URLをDBに記録
  if (royaltyReport.driveUrl || paymentNotice?.driveUrl) {
    await updateManufacturingEventUrls(snapshot.issueKey, {
      royaltyReportUrl: royaltyReport.driveUrl,
      paymentNoticeUrl: paymentNotice?.driveUrl,
    });
  }

  return { royaltyReport, paymentNotice, result };
}

export async function getRoyaltyIssueSnapshot(issueKey: string): Promise<RoyaltyIssueSnapshot> {
  const issue = await backlog.getIssue(issueKey);
  return buildRoyaltyIssueSnapshot(issue);
}

export async function resolveRoyaltyLicenseCondition(
  licenseIssueKey: string,
  licIssue?: Awaited<ReturnType<typeof backlog.getIssue>>,
  requestedConditionNo: 1 | 2 | 3 = 1,
): Promise<{ license: LicenseCondition; meta: ResolvedRoyaltyLicenseConditionMeta }> {
  const issue = licIssue ?? await backlog.getIssue(licenseIssueKey);
  const workflow = await findIssueWorkflowByIssueKey(licenseIssueKey);
  const draft = normalizeDraft(workflow?.documentDraft);
  const getLicField = (envKey: string): string =>
    issue.customFields?.find(
      (f) => f.fieldId === Number(process.env[envKey])
    )?.value ?? "";

  const condition1 = readConditionDraft(draft, getLicField, 1);
  const requestedCondition = requestedConditionNo === 1 ? condition1 : readConditionDraft(draft, getLicField, requestedConditionNo);
  const resolvedConditionNo = hasConditionData(requestedCondition) ? requestedConditionNo : 1;
  const resolvedCondition = resolvedConditionNo === 1 ? condition1 : requestedCondition;

  const directCalcType = getLicField("BACKLOG_FIELD_CALC_TYPE") as RoyaltyCalcType;
  const directRoyaltyRate = parseFloat(getLicField("BACKLOG_FIELD_ROYALTY_RATE") || "");
  const directDistributionRate = parseFloat(getLicField("BACKLOG_FIELD_DISTRIBUTION_RATE") || "");
  const directMgAmount = parseInt(getLicField("BACKLOG_FIELD_MG_AMOUNT") || "", 10);

  const fallbackCalcType = inferPerformanceCalcType(resolvedCondition.calcMethod, resolvedCondition.formula, resolvedCondition.summary) as RoyaltyCalcType;
  const fallbackRate = parseRateText(resolvedCondition.rateText);
  const fallbackDistributionRate = parseRateText(resolvedCondition.shareRateText);
  const fallbackMg = parseMoneyText(resolvedCondition.mgAgText);

  const source = directCalcType || Number.isFinite(directRoyaltyRate) || Number.isFinite(directDistributionRate) || Number.isFinite(directMgAmount)
    ? "license_fields"
    : "license_condition1_fallback";

  const calcType = (directCalcType || fallbackCalcType || "manufacturing") as RoyaltyCalcType;
  const royaltyRate = Number.isFinite(directRoyaltyRate) ? directRoyaltyRate : (fallbackRate ?? 0.08);
  const distributionRate = Number.isFinite(directDistributionRate) ? directDistributionRate : (calcType === "sublicense" ? (fallbackDistributionRate ?? fallbackRate ?? 0.5) : 0.5);
  const mgAmount = Number.isFinite(directMgAmount) ? directMgAmount : (fallbackMg ?? 0);

  const license: LicenseCondition = {
    licenseIssueKey,
    ledgerId: getLicField("BACKLOG_FIELD_LEDGER_ID"),
    licensee: getLicField("BACKLOG_FIELD_LICENSEE") || "株式会社アークライト",
    licensor: getLicField("BACKLOG_FIELD_LICENSOR"),
    originalWork: getLicField("BACKLOG_FIELD_ORIGINAL_WORK"),
    calcType,
    royaltyRate,
    distributionRate,
    mgAmount,
    mgConsumedToDate: parseInt(getLicField("BACKLOG_FIELD_MG_CONSUMED") || "0", 10),
    paymentCycle: (getLicField("BACKLOG_FIELD_PAYMENT_CYCLE") as PaymentCycle) || "event",
    reportingDaysAfterEvent: parseInt(getLicField("BACKLOG_FIELD_REPORT_DAYS") || "30", 10),
    paymentDaysAfterReport: parseInt(getLicField("BACKLOG_FIELD_PAYMENT_DAYS") || "30", 10),
    currency: getLicField("BACKLOG_FIELD_CURRENCY") || "JPY",
  };

  return {
    license,
    meta: {
      source,
      calcTypeLabel: calcType,
      rateSource: Number.isFinite(directRoyaltyRate) || Number.isFinite(directDistributionRate)
        ? "BACKLOG_FIELD_ROYALTY_RATE / BACKLOG_FIELD_DISTRIBUTION_RATE"
        : (resolvedCondition.rateText || resolvedCondition.shareRateText || null),
      mgSource: Number.isFinite(directMgAmount) ? "BACKLOG_FIELD_MG_AMOUNT" : (resolvedCondition.mgAgText || null),
      requestedConditionNo,
      resolvedConditionNo,
      conditionHeading: resolvedCondition.heading || null,
    },
  };
}

function normalizeDraft(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, rawValue]) => [key, rawValue == null ? "" : String(rawValue)])
  );
}

function resolveRequestedRoyaltyConditionNo(value: string | undefined): 1 | 2 | 3 {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  if (parsed === 2 || parsed === 3) return parsed;
  return 1;
}

function buildRoyaltyIssueSnapshot(issue: Awaited<ReturnType<typeof backlog.getIssue>>): RoyaltyIssueSnapshot {
  const getField = (envKey: string): string =>
    issue.customFields?.find((f) => f.fieldId === Number(process.env[envKey]))?.value ?? "";

  const issueTypeName = issue.issueType?.name ?? "";
  const licenseIssueKey = getField("BACKLOG_FIELD_LICENSE_KEY");
  const requestedConditionNo = resolveRequestedRoyaltyConditionNo(getField("BACKLOG_FIELD_ROYALTY_CONDITION_NO"));

  const reportPeriodStart = getField("BACKLOG_FIELD_REPORT_PERIOD_START");
  const reportPeriodEnd = getField("BACKLOG_FIELD_REPORT_PERIOD_END");
  const resolvedDeadlines = resolveRoyaltyDeadlines(issue, {
    reportingDeadlineRaw: reportPeriodEnd || getField("BACKLOG_FIELD_COMPLETION_DATE") || issue.created.slice(0, 10),
    paymentDueDateRaw: issue.dueDate || reportPeriodEnd || issue.created.slice(0, 10),
  });
  const salesAmount = parseInt(getField("BACKLOG_FIELD_NET_SALES").replace(/[,，]/g, "") || "0", 10);
  const receivedAmount = parseInt(getField("BACKLOG_FIELD_RECEIVED_AMOUNT").replace(/[,，]/g, "") || "0", 10);
  const salesQuantity = parseInt(getField("BACKLOG_FIELD_SALES_QUANTITY") || "0", 10);

  const completionDate = getField("BACKLOG_FIELD_COMPLETION_DATE") || reportPeriodEnd;
  const quantity = parseInt(getField("BACKLOG_FIELD_QUANTITY") || "0", 10);
  const sampleQuantity = parseInt(getField("BACKLOG_FIELD_SAMPLE_QUANTITY") || "0", 10);
  const msrp = parseInt(getField("BACKLOG_FIELD_MSRP").replace(/[,，]/g, "") || "0", 10);

  const fallbackNote = reportPeriodStart || reportPeriodEnd
    ? `売上報告対象期間: ${reportPeriodStart || "未設定"} 〜 ${reportPeriodEnd || "未設定"}`
    : "";

  const productName = getField("BACKLOG_FIELD_PRODUCT_NAME") || issue.summary || "";
  const edition = getField("BACKLOG_FIELD_EDITION") || (reportPeriodStart || reportPeriodEnd ? "売上報告" : "");
  const notes = [getField("BACKLOG_FIELD_MFG_NOTES"), fallbackNote].filter(Boolean).join("\n");

  const inferredBaseAmount = salesAmount > 0
    ? salesAmount
    : receivedAmount > 0
      ? receivedAmount
      : msrp;

  return {
    issueKey: issue.issueKey,
    issueTypeName,
    licenseIssueKey,
    requestedConditionNo,
    productName,
    edition,
    completionDate,
    quantity: quantity > 0 ? quantity : (salesQuantity > 0 ? salesQuantity : 1),
    msrp: inferredBaseAmount,
    sampleQuantity,
    notes,
    reportPeriodStart: reportPeriodStart || undefined,
    reportPeriodEnd: reportPeriodEnd || undefined,
    reportingDeadlineRaw: resolvedDeadlines.reportingDeadlineRaw,
    paymentDueDateRaw: resolvedDeadlines.paymentDueDateRaw,
    salesAmount: salesAmount > 0 ? salesAmount : undefined,
    receivedAmount: receivedAmount > 0 ? receivedAmount : undefined,
    salesQuantity: salesQuantity > 0 ? salesQuantity : undefined,
  };
}

function readConditionDraft(
  draft: Record<string, string>,
  getLicField: (envKey: string) => string,
  no: 1 | 2 | 3
) {
  const prefix = `CONDITION${no}_` as const;
  return {
    heading: draft[`${prefix}HEADING`] || getLicField(`BACKLOG_FIELD_CONDITION${no}_HEADING`),
    calcMethod: draft[`${prefix}CALC_METHOD`] || getLicField(`BACKLOG_FIELD_CONDITION${no}_CALC_METHOD`),
    formula: draft[`${prefix}FORMULA`] || getLicField(`BACKLOG_FIELD_CONDITION${no}_FORMULA`),
    summary: draft[`${prefix}SUMMARY`] || getLicField(`BACKLOG_FIELD_CONDITION${no}_SUMMARY`),
    rateText: draft[`${prefix}RATE`] || getLicField(`BACKLOG_FIELD_CONDITION${no}_RATE`),
    shareRateText: draft[`${prefix}SHARE_RATE`] || getLicField(`BACKLOG_FIELD_CONDITION${no}_SHARE_RATE`),
    mgAgText: draft[`${prefix}MG_AG`] || getLicField(`BACKLOG_FIELD_CONDITION${no}_MG_AG`),
  };
}

function hasConditionData(condition: {
  heading?: string;
  calcMethod?: string;
  formula?: string;
  summary?: string;
  rateText?: string;
  shareRateText?: string;
  mgAgText?: string;
}): boolean {
  return Boolean(
    condition.heading ||
    condition.calcMethod ||
    condition.formula ||
    condition.summary ||
    condition.rateText ||
    condition.shareRateText ||
    condition.mgAgText
  );
}

// ================================================================
// HTML → PDF → Drive
// ================================================================

export interface GeneratedFile {
  filename: string;
  localPath: string;
  driveUrl?: string;
}

interface RoyaltyPaymentRecipient {
  licensor: string;
  licensorRepresentative?: string | null;
  licensorBankName: string | null;
  licensorBranchName: string | null;
  licensorAccountType: string | null;
  licensorAccountNo: string | null;
  licensorAccountName: string | null;
  licensorInvoiceNum: string | null;
}

async function renderRoyaltyPaymentNotice(params: {
  manufacturingIssueKey: string;
  licenseRecord: RoyaltyPaymentRecipient;
  result: RoyaltyCalculationResult;
  driveFolderKey?: string;
}): Promise<GeneratedFile> {
  const paymentBreakdown = calculatePaymentBreakdown({
    amountExTax: params.result.actualRoyalty,
    consumptionTaxRate: params.result.taxRate,
  });

  const document = await renderTemplate({
    templateKey: "payment_notice",
    outputBasename: `${params.manufacturingIssueKey}_支払通知書`,
    driveFolderKey: params.driveFolderKey,
    variables: {
      notice_id: `ROYALTY-PAY-${params.manufacturingIssueKey}`,
      notice_date: new Date(),
      vendor_name: params.licenseRecord?.licensor ?? "",
      vendor_representative: params.licenseRecord?.licensorRepresentative ?? "",
      vendor_representative_sama: params.licenseRecord?.licensorRepresentative
        ? `${params.licenseRecord.licensorRepresentative} 様`
        : "",
      vendorSuffix: "御中",
      vendor_invoice_num: params.licenseRecord?.licensorInvoiceNum ?? "",
      STAFF_NAME: process.env.LEGAL_STAFF_NAME ?? "",
      totalWithTax: paymentBreakdown.totalWithTax,
      expenseAmount: null,
      withholdingTax: paymentBreakdown.withholdingTaxAmount || null,
      paymentAmount: paymentBreakdown.paymentAmount,
      showWithholdingNote: false,
      withholdingRateLabel: "",
      items: [
        {
          order_no: params.manufacturingIssueKey,
          name: `${params.result.productName}${params.result.edition ? `（${params.result.edition}）` : ""}`,
          detail: `${params.result.originalWork} / 税抜ロイヤリティ ¥${params.result.actualRoyaltyStr}`,
          amount: paymentBreakdown.paymentAmount,
        },
      ],
      payment_due_date: params.result.paymentDueDate,
      BANK_NAME: params.licenseRecord?.licensorBankName ?? "",
      BRANCH_NAME: params.licenseRecord?.licensorBranchName ?? "",
      ACCOUNT_TYPE: params.licenseRecord?.licensorAccountType ?? process.env.PAYMENT_ACCOUNT_TYPE ?? "普通",
      ACCOUNT_NUMBER: params.licenseRecord?.licensorAccountNo ?? "",
      BANK_ACCOUNT_NAME: params.licenseRecord?.licensorAccountName ?? "",
    },
  });

  return {
    filename: document.filename,
    localPath: document.localPath,
    driveUrl: document.driveUrl,
  };
}

async function renderAndSave(
  templateFile: string,
  variables: Record<string, unknown>,
  basename: string,
  driveFolderKey?: string,
): Promise<GeneratedFile> {
  const templatePath = path.join(TEMPLATE_DIR, templateFile);
  const source = fs.readFileSync(templatePath, "utf-8");
  const template = Handlebars.compile(source);
  const html = template(variables);

  fs.mkdirSync(TMP_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const htmlPath = path.join(TMP_DIR, `${basename}_${ts}.html`);
  const pdfPath = path.join(TMP_DIR, `${basename}_${ts}.pdf`);

  fs.writeFileSync(htmlPath, html, "utf-8");

  let finalPath = htmlPath;
  let filename = path.basename(htmlPath);

  if (isWeasyPrintAvailable()) {
    try {
      execSync(`weasyprint "${htmlPath}" "${pdfPath}"`, { timeout: 30_000 });
      finalPath = pdfPath;
      filename = path.basename(pdfPath);
      fs.unlinkSync(htmlPath);
      console.log(`[RoyaltyGen] PDF生成: ${filename}`);
    } catch (e) {
      console.warn(`[RoyaltyGen] WeasyPrint失敗: ${e}`);
    }
  }

  const result: GeneratedFile = { filename, localPath: finalPath };

  try {
    result.driveUrl = await uploadToDrive(filename, finalPath, driveFolderKey);
  } catch (e) {
    console.error(`[RoyaltyGen] Driveアップロード失敗: ${e}`);
  }

  return result;
}

async function uploadToDrive(filename: string, filePath: string, driveFolderKey?: string): Promise<string> {
  const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH;
  const { resolveDriveFolderId } = await import("./driveFolders");
  const folderId = resolveDriveFolderId(driveFolderKey);
  if (!keyPath || !folderId) throw new Error("Drive環境変数未設定");

  const auth = new google.auth.GoogleAuth({
    keyFile: keyPath,
    scopes: ["https://www.googleapis.com/auth/drive.file"],
  });
  const drive = google.drive({ version: "v3", auth });
  const mimeType = filename.endsWith(".pdf") ? "application/pdf" : "text/html";

  const res = await drive.files.create({
    requestBody: { name: filename, parents: [folderId] },
    media: { mimeType, body: fs.createReadStream(filePath) },
    fields: "id, webViewLink",
  });
  await drive.permissions.create({
    fileId: res.data.id!,
    requestBody: { type: "anyone", role: "reader" },
  });
  return res.data.webViewLink ?? `https://drive.google.com/file/d/${res.data.id}`;
}

function isWeasyPrintAvailable(): boolean {
  try { execSync("weasyprint --version", { stdio: "pipe" }); return true; }
  catch { return false; }
}
