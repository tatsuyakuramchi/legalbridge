import Papa from "papaparse";
import { backlog, BacklogIssue } from "../backlog/client";
import { createLegalRequest, findLegalRequestByBacklogKey } from "../db/repository";
import { RawOrderItem, upsertOrderItems } from "../db/orderRepository";
import { buildPlanningImportContext, PlanningImportContext, savePlanningImportContext } from "./importContextStore";
import { getPlanningImportSettings } from "./planningImportSettings";
import { getPaymentMethodLabel, normalizePaymentMethodCode } from "../payments/methods";

const PUBLISHING_BULK_FIXED_HEADERS = [
  "担当者ID",
  "発注日",
  "支払日",
  "コード",
  "支払先（ペンネーム）",
  "書籍名",
  "業務概要",
  "業務詳細（仕様）",
  "単価（税込）",
  "数量",
  "発注金額（税別）",
  "初校締切",
  "再校締切",
  "校了予定",
  "備考",
];

export interface ParsedCsvOrderItem extends RawOrderItem {
  amountSource?: string;
  amountSourceLabel?: string;
}

export interface ParseOrderCsvOptions {
  mode?: "generic" | "planning";
  mappingProfileId?: string;
  sourceFileName?: string;
  projectTitle?: string;
  specialTerms?: string;
  remarks?: string;
  acceptMethod?: string;
  acceptReplyDueDate?: string;
}

export interface ParsedOrderCsvResult {
  mode: "generic" | "planning";
  items: ParsedCsvOrderItem[];
  planningContext?: Omit<PlanningImportContext, "issueKey" | "importedAt">;
}

export interface ParsedInspectionCsvRow {
  itemNo: number;
  vendorCode?: string;
  vendorLookupValue?: string;
  description: string;
  inspectionDate?: string;
  paymentPlannedDate?: string;
}

const COLUMN_ALIASES: Record<string, string[]> = {
  no: ["no", "番号", "明細番号"],
  vendorCode: ["vendor_code", "vendorcode", "registration_no", "registration_number", "登録番号"],
  category: ["category", "区分"],
  payMethod: ["pay_method", "paymethod", "支払方法"],
  installmentCount: ["installment_count", "分割回数"],
  paymentStartDate: ["payment_start_date", "first_payment_date", "初回支払日"],
  paymentIntervalMonths: ["payment_interval_months", "支払間隔月数"],
  subscriptionMonths: ["subscription_months", "サブスク期間月数", "サブスク月数"],
  qty: ["qty", "quantity", "数量"],
  unitPrice: ["unit_price", "unitprice", "単価"],
  desc: ["desc", "item_name", "name", "件名", "業務内容", "成果物名"],
  spec: ["spec", "detail", "detail_text", "仕様", "明細内容", "備考"],
  amount: ["amount", "金額", "金額税抜", "税抜金額"],
  dueDate: ["due_date", "delivery_date", "納期", "納品日"],
};

export function parseOrderCsv(csvText: string, options: ParseOrderCsvOptions = {}): ParsedOrderCsvResult {
  if (options.mode === "planning") {
    return parsePlanningOrderCsv(csvText, options);
  }
  return {
    mode: "generic",
    items: parseGenericOrderCsv(csvText),
  };
}

export function extractCsvHeaders(csvText: string): string[] {
  const parsed = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    preview: 1,
    skipEmptyLines: true,
    transformHeader: (header) => header.trim(),
  });
  if (parsed.errors.length > 0) {
    throw new Error(`CSVヘッダーの取得に失敗しました: ${parsed.errors[0].message}`);
  }
  return (parsed.meta.fields ?? []).map((field) => String(field).trim()).filter(Boolean);
}

export function parsePlanningInspectionCsv(
  csvText: string,
  options: Pick<ParseOrderCsvOptions, "mappingProfileId"> = {},
): ParsedInspectionCsvRow[] {
  const settings = getPlanningImportSettings(options.mappingProfileId);
  const rows = parseCsvRows(csvText).filter((row) => getValueByHeader(row, settings.itemNameColumn));

  return rows.map((row, index) => {
    const description = getValueByHeader(row, settings.itemNameColumn);
    const inspectionDateRaw = readPreferredHeader(row, ["検収日", "inspection_date", "inspectionDate"]);
    const paymentPlannedDateRaw = readPreferredHeader(row, ["支払予定日", "payment_planned_date", "paymentPlannedDate"]);
    const inspectionDate = inspectionDateRaw ? normalizeDate(inspectionDateRaw) : "";
    const paymentPlannedDate = paymentPlannedDateRaw ? normalizeDate(paymentPlannedDateRaw) : "";

    if (inspectionDateRaw && !inspectionDate) {
      throw new Error(`CSV ${index + 2}行目: 検収日 が空か日付形式ではありません`);
    }
    if (paymentPlannedDateRaw && !paymentPlannedDate) {
      throw new Error(`CSV ${index + 2}行目: 支払予定日 が空か日付形式ではありません`);
    }

    return {
      itemNo: index + 1,
      vendorCode: getValueByHeader(row, settings.vendorCodeColumn) || undefined,
      vendorLookupValue: getValueByHeader(row, settings.vendorLookupColumn) || undefined,
      description,
      inspectionDate: inspectionDate || undefined,
      paymentPlannedDate: paymentPlannedDate || undefined,
    };
  });
}

export async function importOrderCsvForIssue(input: {
  issue: BacklogIssue;
  csvText: string;
  contractType?: string;
  mode?: "generic" | "planning";
  mappingProfileId?: string;
  sourceFileName?: string;
  projectTitle?: string;
  specialTerms?: string;
  remarks?: string;
  acceptMethod?: string;
  acceptReplyDueDate?: string;
}): Promise<{ legalRequestId: string; items: ParsedCsvOrderItem[]; mode: "generic" | "planning" }> {
  const { issue, csvText } = input;
  const mode = input.mode ?? (issue.issueType?.name === "企画発注書" ? "planning" : "generic");
  const parsed = parseOrderCsv(csvText, {
    mode,
    mappingProfileId: input.mappingProfileId,
    sourceFileName: input.sourceFileName,
    projectTitle: input.projectTitle,
    specialTerms: input.specialTerms,
    remarks: input.remarks,
    acceptMethod: input.acceptMethod,
    acceptReplyDueDate: input.acceptReplyDueDate,
  });

  let legalRequest = await findLegalRequestByBacklogKey(issue.issueKey);
  if (!legalRequest) {
    legalRequest = await createLegalRequest({
      backlogIssueKey: issue.issueKey,
      slackUserId: `backlog:${issue.issueKey}`,
      contractType: input.contractType ?? issue.issueType?.name ?? "order",
      counterparty: getCustomFieldValue(issue, process.env.BACKLOG_FIELD_COUNTERPARTY) ?? "未設定",
      summary: parsed.planningContext?.projectTitle ?? issue.summary,
      notes: "CSV一括発注で作成",
    });
  }

  await upsertOrderItems(legalRequest.id, JSON.stringify(parsed.items));

  if (parsed.mode === "planning" && parsed.planningContext) {
    savePlanningImportContext({
      issueKey: issue.issueKey,
      ...parsed.planningContext,
      importedAt: new Date().toISOString(),
    });
  }

  await backlog.addComment(
    issue.issueKey,
    `✅ CSV一括発注を取り込みました。\n\n- 明細数: ${parsed.items.length}件\n- 取込方法: ${parsed.mode === "planning" ? "企画発注マッピング" : "Papa Parse"}`
  );

  return { legalRequestId: legalRequest.id, items: parsed.items, mode: parsed.mode };
}

function parseGenericOrderCsv(csvText: string): ParsedCsvOrderItem[] {
  const parsed = parseCsvRows(csvText);

  return parsed.map((row, index) => {
    const no = parseInt(readColumn(row, "no") || String(index + 1), 10);
    const qty = parseInt(readColumn(row, "qty") || "1", 10);
    const unitPriceText = normalizeNumberText(readColumn(row, "unitPrice"));
    const amountText = normalizeNumberText(readColumn(row, "amount"));
    const unitPrice = unitPriceText ? parseInt(unitPriceText, 10) : undefined;
    const amount = amountText ? parseInt(amountText, 10) : (unitPrice ?? 0) * qty;
    const dueDate = normalizeDate(readColumn(row, "dueDate"));
    const desc = readColumn(row, "desc");
    const vendorCode = readColumn(row, "vendorCode");

    if (!desc) {
      throw new Error(`CSV ${index + 2}行目: 業務内容/件名が空です`);
    }
    if (!vendorCode) {
      throw new Error(`CSV ${index + 2}行目: 登録番号が空です。個人は執筆登録、法人は法人登録番号を入れてください`);
    }
    if (!dueDate) {
      throw new Error(`CSV ${index + 2}行目: 納期が空か日付形式ではありません`);
    }

    return {
      no,
      vendorCode,
      category: readColumn(row, "category") || undefined,
      payMethod: normalizePayMethod(readColumn(row, "payMethod")),
      installmentCount: parseOptionalInt(readColumn(row, "installmentCount")),
      paymentStartDate: normalizeDate(readColumn(row, "paymentStartDate")) || undefined,
      paymentIntervalMonths: parseOptionalInt(readColumn(row, "paymentIntervalMonths")),
      subscriptionMonths: parseOptionalInt(readColumn(row, "subscriptionMonths")),
      qty,
      unitPrice: unitPrice ?? amount,
      desc,
      spec: readColumn(row, "spec") || undefined,
      amount,
      dueDate,
    };
  });
}

function parsePlanningOrderCsv(csvText: string, options: ParseOrderCsvOptions): ParsedOrderCsvResult {
  const settings = getPlanningImportSettings(options.mappingProfileId);
  const csv = parseCsvRowsWithHeaders(csvText);
  if (options.mappingProfileId === "publishing_bulk") {
    validatePublishingBulkHeaders(csv.headers);
  }
  const rows = csv.rows.filter((row) => getValueByHeader(row, settings.itemNameColumn));
  const groupMap = new Map<string, {
    vendorCode: string;
    vendorLookupValue?: string;
    requesterSlackUserId?: string;
    completionDates: string[];
    finalDeadlineValues: string[];
    orderDateValues: string[];
    paymentDateValues: string[];
    rowCount: number;
  }>();

  const items = rows.map((row, index) => {
    if (options.mappingProfileId === "publishing_bulk") {
      validatePublishingBulkRow(row, index);
    }

    const vendorCode = getValueByHeader(row, settings.vendorCodeColumn);
    const vendorLookupValue = getValueByHeader(row, settings.vendorLookupColumn);
    const requesterSlackUserId = getValueByHeader(row, settings.requesterSlackUserIdColumn) || undefined;
    if (!vendorCode && settings.vendorCodeColumn) {
      throw new Error(`CSV ${index + 2}行目: ${settings.vendorCodeColumn} が空です。vendorID を入れてください。`);
    }
    if (!vendorLookupValue) {
      throw new Error(`CSV ${index + 2}行目: ${settings.vendorLookupColumn} が空です。`);
    }

    const desc = getValueByHeader(row, settings.itemNameColumn);
    if (!desc) {
      throw new Error(`CSV ${index + 2}行目: ${settings.itemNameColumn} が空です`);
    }

    const completionDateRaw = getValueByHeader(row, settings.completionDateColumn) || getValueByHeader(row, settings.completionDateFallbackColumn);
    const dueDate = normalizeDate(completionDateRaw);
    if (!dueDate) {
      throw new Error(`CSV ${index + 2}行目: ${settings.completionDateColumn} / ${settings.completionDateFallbackColumn} が空か日付形式ではありません`);
    }

    const orderDateRaw = getValueByHeader(row, settings.orderDateColumn);
    const orderDate = orderDateRaw ? normalizeDate(orderDateRaw) : "";
    if (orderDateRaw && !orderDate) {
      throw new Error(`CSV ${index + 2}行目: ${settings.orderDateColumn} が空か日付形式ではありません`);
    }
    const paymentDateRaw = getValueByHeader(row, settings.paymentDateColumn);
    const paymentDate = paymentDateRaw ? normalizeDate(paymentDateRaw) : "";
    if (paymentDateRaw && !paymentDate) {
      throw new Error(`CSV ${index + 2}行目: ${settings.paymentDateColumn} が空か日付形式ではありません`);
    }

    const group = groupMap.get(vendorCode) ?? {
      vendorCode,
      vendorLookupValue,
      requesterSlackUserId,
      completionDates: [],
      finalDeadlineValues: [],
      orderDateValues: [],
      paymentDateValues: [],
      rowCount: 0,
    };
    group.completionDates.push(dueDate);
    group.finalDeadlineValues.push(getValueByHeader(row, settings.finalDeadlineColumn));
    if (!group.requesterSlackUserId && requesterSlackUserId) {
      group.requesterSlackUserId = requesterSlackUserId;
    }
    if (orderDate) {
      group.orderDateValues.push(orderDate);
    }
    if (paymentDate) {
      group.paymentDateValues.push(paymentDate);
    }
    group.rowCount += 1;
    groupMap.set(vendorCode, group);

    const qty = parseOptionalInt(getValueByHeader(row, settings.quantityColumn)) ?? 1;
    const unitPrice = parseOptionalInt(getValueByHeader(row, settings.unitPriceColumn));
    const primaryAmount = parseOptionalInt(getValueByHeader(row, settings.amountColumn));
    const fallbackAmount = parseOptionalInt(getValueByHeader(row, settings.amountFallbackColumn));
    const amount = primaryAmount ?? fallbackAmount ?? (unitPrice ?? 0) * qty;
    const amountSource = primaryAmount !== undefined
      ? "primary"
      : fallbackAmount !== undefined
        ? "fallback"
        : unitPrice !== undefined
          ? "unitPrice"
          : "missing";
    const amountSourceLabel = primaryAmount !== undefined
      ? settings.amountColumn
      : fallbackAmount !== undefined
        ? settings.amountFallbackColumn
        : unitPrice !== undefined
          ? settings.unitPriceColumn || "unitPrice"
          : "未設定";

    return {
      no: index + 1,
      vendorCode,
      category: settings.constants.category,
      payMethod: normalizePayMethod(settings.constants.payMethod),
      installmentCount: undefined,
      paymentStartDate: undefined,
      paymentIntervalMonths: undefined,
      subscriptionMonths: undefined,
      qty,
      unitPrice: unitPrice ?? amount,
      desc,
      spec: buildPlanningDetailText(row, settings.detailColumns),
      amount,
      dueDate,
      amountSource,
      amountSourceLabel,
    };
  });

  const planningContextBase = buildPlanningImportContext({
    issueKey: "__preview__",
    sourceFileName: options.sourceFileName,
    projectTitle: deriveProjectTitle(options.projectTitle, options.sourceFileName, settings),
    specialTerms: options.specialTerms,
    remarks: options.remarks,
    acceptMethod: options.acceptMethod,
    acceptReplyDueDate: options.acceptReplyDueDate,
    groups: Array.from(groupMap.values()),
    rowCount: items.length,
    settings,
  });

  const { issueKey: _issueKey, importedAt: _importedAt, ...planningContext } = planningContextBase;
  return {
    mode: "planning",
    items,
    planningContext,
  };
}

function parseCsvRows(csvText: string): Array<Record<string, string>> {
  return parseCsvRowsWithHeaders(csvText).rows;
}

function parseCsvRowsWithHeaders(csvText: string): { rows: Array<Record<string, string>>; headers: string[] } {
  const parsed = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (header) => header.trim(),
  });

  if (parsed.errors.length > 0) {
    throw new Error(`CSVパースに失敗しました: ${parsed.errors[0].message}`);
  }

  const headers = (parsed.meta.fields ?? []).map((field) => String(field ?? "").trim()).filter(Boolean);
  return {
    rows: parsed.data,
    headers,
  };
}

function readColumn(row: Record<string, string>, key: string): string {
  const aliases = COLUMN_ALIASES[key] ?? [key];
  for (const alias of aliases) {
    const found = Object.entries(row).find(([header]) => header.trim().toLowerCase() === alias.toLowerCase());
    if (found && found[1] !== undefined && found[1] !== null) {
      return String(found[1]).trim();
    }
  }
  return "";
}

function getValueByHeader(row: Record<string, string>, headerName: string): string {
  const normalizedTarget = headerName.trim().toLowerCase();
  if (!normalizedTarget) return "";
  const found = Object.entries(row).find(([header]) => header.trim().toLowerCase() === normalizedTarget);
  return found ? String(found[1] ?? "").trim() : "";
}

function readPreferredHeader(row: Record<string, string>, headerNames: string[]): string {
  for (const headerName of headerNames) {
    const value = getValueByHeader(row, headerName);
    if (value) return value;
  }
  return "";
}

function buildPlanningDetailText(row: Record<string, string>, detailColumns: string[]): string {
  return detailColumns
    .map((column) => {
      const value = getValueByHeader(row, column);
      return value ? `${column}: ${value}` : "";
    })
    .filter(Boolean)
    .join("\n");
}

function deriveProjectTitle(
  explicitProjectTitle: string | undefined,
  sourceFileName: string | undefined,
  settings: ReturnType<typeof getPlanningImportSettings>
): string | undefined {
  const explicit = String(explicitProjectTitle ?? "").trim();
  if (explicit) return explicit;
  if (settings.projectTitleSource === "manual" && settings.projectTitleManualValue.trim()) {
    return settings.projectTitleManualValue.trim();
  }
  const source = String(sourceFileName ?? "").trim();
  if (!source) return undefined;
  return source.replace(/\.[^.]+$/, "");
}

function parseOptionalInt(value: string): number | undefined {
  const text = normalizeNumberText(value);
  if (!text) return undefined;
  const parsed = parseInt(text, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function firstNonEmpty(values: string[]): string | undefined {
  return values.map((value) => value.trim()).find(Boolean);
}

function collectDistinctValues(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function normalizeNumberText(value: string): string {
  return String(value || "").replace(/[¥,\s，]/g, "").trim();
}

function normalizeDate(value: string): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const normalized = raw.replace(/\./g, "-").replace(/\//g, "-");
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

function normalizePayMethod(value: string): string | undefined {
  const text = String(value ?? "").trim();
  if (!text) return undefined;
  return getPaymentMethodLabel(normalizePaymentMethodCode(text));
}

function validatePublishingBulkHeaders(headers: string[]): void {
  const input = headers.map((header) => header.trim());
  const expected = PUBLISHING_BULK_FIXED_HEADERS;
  if (input.length !== expected.length) {
    throw new Error(
      `CSVヘッダーが固定フォーマットと一致しません。期待列数: ${expected.length} / 入力列数: ${input.length}`
    );
  }
  for (let i = 0; i < expected.length; i += 1) {
    if (input[i] !== expected[i]) {
      throw new Error(
        `CSVヘッダー${i + 1}列目が不一致です。期待: 「${expected[i]}」 / 入力: 「${input[i] || "(空)"}」`
      );
    }
  }
}

function validatePublishingBulkRow(row: Record<string, string>, index: number): void {
  const rowNo = index + 2;
  const staffId = getValueByHeader(row, "担当者ID");
  const orderDate = getValueByHeader(row, "発注日");
  const paymentDate = getValueByHeader(row, "支払日");
  const vendorCode = getValueByHeader(row, "コード");
  const vendorName = getValueByHeader(row, "支払先（ペンネーム）");
  const itemName = getValueByHeader(row, "書籍名");
  const qtyText = getValueByHeader(row, "数量");
  const unitPriceText = getValueByHeader(row, "単価（税込）");
  const amountText = getValueByHeader(row, "発注金額（税別）");
  const firstDeadline = getValueByHeader(row, "初校締切");
  const secondDeadline = getValueByHeader(row, "再校締切");
  const finalDeadline = getValueByHeader(row, "校了予定");

  if (!staffId || !/^U[A-Z0-9]{8,}$/.test(staffId)) {
    throw new Error(`CSV ${rowNo}行目: 担当者ID は SlackユーザーID形式 (例: U0123456789) で入力してください`);
  }
  if (!normalizeDate(orderDate)) {
    throw new Error(`CSV ${rowNo}行目: 発注日 は日付形式で必須です`);
  }
  if (!normalizeDate(paymentDate)) {
    throw new Error(`CSV ${rowNo}行目: 支払日 は日付形式で必須です`);
  }
  if (!vendorCode || !/^[A-Za-z0-9_-]+$/.test(vendorCode)) {
    throw new Error(`CSV ${rowNo}行目: コード は英数字・ハイフン・アンダースコアのみで入力してください`);
  }
  if (!vendorName) {
    throw new Error(`CSV ${rowNo}行目: 支払先（ペンネーム）は必須です`);
  }
  if (!itemName) {
    throw new Error(`CSV ${rowNo}行目: 書籍名は必須です`);
  }

  const qty = parseOptionalInt(qtyText);
  const unitPrice = parseOptionalInt(unitPriceText);
  const amount = parseOptionalInt(amountText);
  if (!qty || qty <= 0) {
    throw new Error(`CSV ${rowNo}行目: 数量 は 1 以上の整数で入力してください`);
  }
  if (!unitPrice || unitPrice <= 0) {
    throw new Error(`CSV ${rowNo}行目: 単価（税込） は 1 以上の整数で入力してください`);
  }
  if (!amount || amount <= 0) {
    throw new Error(`CSV ${rowNo}行目: 発注金額（税別） は 1 以上の整数で入力してください`);
  }
  if (!normalizeDate(firstDeadline)) {
    throw new Error(`CSV ${rowNo}行目: 初校締切 は日付形式で必須です`);
  }
  if (secondDeadline && !normalizeDate(secondDeadline)) {
    throw new Error(`CSV ${rowNo}行目: 再校締切 は日付形式で入力してください`);
  }
  if (finalDeadline && !normalizeDate(finalDeadline)) {
    throw new Error(`CSV ${rowNo}行目: 校了予定 は日付形式で入力してください`);
  }
}

function getCustomFieldValue(issue: BacklogIssue, fieldIdRaw?: string): string | undefined {
  const fieldId = Number(fieldIdRaw);
  if (!fieldId) return undefined;
  const raw = issue.customFields?.find((field) => field.fieldId === fieldId)?.value;
  return raw ?? undefined;
}
