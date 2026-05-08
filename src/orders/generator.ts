import { backlog, BacklogIssue } from "../backlog/client";
import { resolveOrderDeliveryDeadline } from "../backlog/deadlines";
import { resolveDriveFolderKey, resolveRequesterSlackId } from "../backlog/issueContext";
import { renderHtmlDocument, renderTemplate, renderTemplateHtml } from "../documents/templateRenderer";
import {
  findLegalRequestByBacklogKey,
  findStaffBySlackUserId,
  matchVendor,
  saveGeneratedDocuments,
} from "../db/repository";
import { getOrderItems, upsertOrderItems } from "../db/orderRepository";
import { loadPlanningImportContext } from "./importContextStore";
import {
  getBacklogCustomFieldValue,
  resolveIssueDocumentDate,
  resolveIssueDocumentNumber,
} from "../workflow/documentDefaults";
import { getPaymentMethodLabel, normalizePaymentMethodCode } from "../payments/methods";

type StaffRecord = Awaited<ReturnType<typeof findStaffBySlackUserId>>;

export async function generateOrderDocumentsFromIssue(issue: BacklogIssue): Promise<void> {
  const legalRequest = await ensureLegalRequest(issue);
  const items = await getOrderItems(legalRequest.id);

  if (items.length === 0) {
    const orderItemsJson = getCustomFieldValue(issue, process.env.BACKLOG_FIELD_ORDER_ITEMS_JSON);
    if (!orderItemsJson) {
      throw new Error(`発注明細が未登録です: ${issue.issueKey}`);
    }
    await upsertOrderItems(legalRequest.id, orderItemsJson);
  }

  const refreshedItems = await getOrderItems(legalRequest.id);
  const documentDateText = resolveIssueDocumentDate(issue);
  const planningContext = issue.issueType?.name === "企画発注書" ? loadPlanningImportContext(issue.issueKey) : null;
  const orderDate = getDateValue(planningContext?.orderDate) ?? getDateValue(documentDateText) ?? new Date(issue.created);
  const dueDate = resolveOrderDeliveryDeadline(issue);
  const hasBaseContract = Boolean(getCustomFieldValue(issue, process.env.BACKLOG_FIELD_MASTER_CONTRACT_REF));
  const requesterSlackId = planningContext?.requesterSlackUserId ?? resolveRequesterSlackId(issue, legalRequest);
  const staff = await findStaffBySlackUserIdWithFallback(requesterSlackId);
  const documentNumber = await resolveIssueDocumentNumber(backlog, issue, {
    partyAName: staff?.partyAName,
    departmentCode: staff?.departmentCode ?? undefined,
  });
  if (!getCustomFieldValue(issue, process.env.BACKLOG_FIELD_CONTRACT_NO) && process.env.BACKLOG_FIELD_CONTRACT_NO) {
    try {
      await backlog.updateCustomField(issue.issueKey, Number(process.env.BACKLOG_FIELD_CONTRACT_NO), documentNumber);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[Orders] 契約番号カスタム項目の更新をスキップします (${issue.issueKey}): ${message}`);
    }
  }
  const isPlanning = issue.issueType?.name === "企画発注書";

  if (isPlanning) {
    const rendered = await renderPlanningDocumentsByVendor({
      issue,
      legalRequest,
      items: refreshedItems,
      planningContext,
      orderDate,
      dueDate,
      staff,
    });
    await saveGeneratedDocuments(issue.issueKey, rendered.map((doc, index) => ({
      name: `order_planning_${index + 1}`,
      url: doc.driveUrl,
      localPath: doc.localPath,
    })));
    await backlog.addComment(
      issue.issueKey,
      `## ✅ 企画発注書を生成しました\n\n${rendered
        .map((doc) => `- ${doc.filename}: ${doc.driveUrl ?? doc.localPath}`)
        .join("\n")}`
    );
    return;
  }
  const renderedByVendor = await renderStandardOrderDocumentsByVendor({
    issue,
    legalRequest,
    items: refreshedItems,
    orderDate,
    dueDate,
    hasBaseContract,
    staff,
    documentNumber,
  });

  await saveGeneratedDocuments(issue.issueKey, renderedByVendor.map((doc, index) => ({
    name: renderedByVendor.length === 1
      ? "order"
      : `order_${sanitizeDocumentNameSegment(doc.vendorCode || String(index + 1))}`,
    url: doc.driveUrl,
    localPath: doc.localPath,
  })));

  await backlog.addComment(
    issue.issueKey,
    `## ✅ 発注書を生成しました\n\n${renderedByVendor
      .map((doc) => `- ${doc.filename}: ${doc.driveUrl ?? doc.localPath}`)
      .join("\n")}`
  );
}

async function renderPlanningDocumentsByVendor(input: {
  issue: BacklogIssue;
  legalRequest: Awaited<ReturnType<typeof ensureLegalRequest>>;
  items: Awaited<ReturnType<typeof getOrderItems>>;
  planningContext: ReturnType<typeof loadPlanningImportContext>;
  orderDate: Date;
  dueDate?: Date;
  staff: Awaited<ReturnType<typeof findStaffBySlackUserId>> | null;
}) {
  const groups = new Map<string, typeof input.items>();
  for (const item of input.items) {
    const vendorCode = item.vendorCode ?? "UNKNOWN";
    const list = groups.get(vendorCode) ?? [];
    list.push(item);
    groups.set(vendorCode, list);
  }

  const rendered = [];
  for (const [vendorCode, groupItems] of groups.entries()) {
    const groupContext = input.planningContext?.groups.find((group) => group.vendorCode === vendorCode);
    const groupStaff = await findStaffBySlackUserIdWithFallback(groupContext?.requesterSlackUserId) ?? input.staff;
    const groupDocumentNumber = await resolveIssueDocumentNumber(backlog, input.issue, {
      partyAName: groupStaff?.partyAName ?? input.staff?.partyAName,
      departmentCode: groupStaff?.departmentCode ?? input.staff?.departmentCode ?? undefined,
    });
    const vendor = await matchVendor({
      vendorCode: vendorCode !== "UNKNOWN" ? vendorCode : undefined,
      vendorName: groupContext?.vendorLookupValue ?? input.legalRequest.counterparty,
    });
    const vendorRepresentative =
      getCustomFieldValue(input.issue, process.env.BACKLOG_FIELD_COUNTERPARTY_REP)
      ?? vendor?.vendorRepresentative
      ?? vendor?.contactName
      ?? "";
    const planningProjectTitle = resolvePlanningProjectTitle(input.issue, input.planningContext);
    const common = {
      ORDER_NO: `${groupDocumentNumber}-${vendorCode}`,
      ORDER_DATE_YEAR: String(input.orderDate.getFullYear()),
      ORDER_DATE_MONTH: String(input.orderDate.getMonth() + 1),
      ORDER_DATE_DAY: String(input.orderDate.getDate()),
      PROJECT_TITLE: planningProjectTitle,
      VENDOR_NAME: getCustomFieldValue(input.issue, process.env.BACKLOG_FIELD_COUNTERPARTY) ?? vendor?.vendorName ?? groupContext?.vendorLookupValue ?? input.legalRequest.counterparty,
      VENDOR_SUFFIX: vendor?.vendorSuffix ?? "御中",
      VENDOR_ADDRESS: getCustomFieldValue(input.issue, process.env.BACKLOG_FIELD_COUNTERPARTY_ADDRESS) ?? vendor?.address ?? "",
      VENDOR_REPRESENTATIVE: vendorRepresentative,
      VENDOR_REPRESENTATIVE_SAMA: vendorRepresentative ? `${vendorRepresentative} 様` : "",
      VENDOR_EMAIL: vendor?.email ?? "",
      VENDOR_CONTACT_NAME: getCustomFieldValue(input.issue, process.env.BACKLOG_FIELD_VENDOR_ACCEPT_NAME) ?? vendor?.contactName ?? "",
      VENDOR_CONTACT_DEPARTMENT: getCustomFieldValue(input.issue, process.env.BACKLOG_FIELD_VENDOR_CONTACT_DEPARTMENT) ?? vendor?.contactDepartment ?? "",
      PARTY_A_NAME: groupStaff?.partyAName ?? "株式会社アークライト",
      PARTY_A_ADDRESS: groupStaff?.partyAAddress ?? "〒101-0052 東京都千代田区神田小川町1-2 風雲堂ビル2階",
      PARTY_A_REP: groupStaff?.partyARep ?? "代表取締役 青柳昌行",
      STAFF_DEPARTMENT: groupStaff?.department ?? groupStaff?.departmentCode ?? "",
      STAFF_NAME: groupStaff?.staffName ?? "",
      STAFF_PHONE: groupStaff?.phone ?? "",
      STAFF_EMAIL: groupStaff?.email ?? "",
      BANK_INFO: getCustomFieldValue(input.issue, process.env.BACKLOG_FIELD_BANK_INFO) ?? vendor?.bankInfo ?? "",
      BANK_NAME: getCustomFieldValue(input.issue, process.env.BACKLOG_FIELD_BANK_NAME) ?? vendor?.bankName ?? "",
      BRANCH_NAME: getCustomFieldValue(input.issue, process.env.BACKLOG_FIELD_BRANCH_NAME) ?? vendor?.branchName ?? "",
      ACCOUNT_TYPE: getCustomFieldValue(input.issue, process.env.BACKLOG_FIELD_ACCOUNT_TYPE) ?? vendor?.accountType ?? "",
      ACCOUNT_NUMBER: getCustomFieldValue(input.issue, process.env.BACKLOG_FIELD_ACCOUNT_NUMBER) ?? vendor?.accountNumber ?? "",
      ACCOUNT_HOLDER_KANA: getCustomFieldValue(input.issue, process.env.BACKLOG_FIELD_ACCOUNT_HOLDER_KANA) ?? vendor?.accountHolderKana ?? "",
      INVOICE_REGISTRATION_NUMBER: getCustomFieldValue(input.issue, process.env.BACKLOG_FIELD_INVOICE_REGISTRATION_NUMBER) ?? vendor?.invoiceRegistrationNumber ?? "",
      TRANSFER_FEE_PAYER: getCustomFieldValue(input.issue, process.env.BACKLOG_FIELD_TRANSFER_FEE_PAYER) ?? input.planningContext?.transferFeePayer ?? "",
      PAYMENT_TERMS: "明細参照",
      summaryPaymentTerms: "明細参照",
      summaryDeliveryDate: groupContext?.finalDeadlineLabel ?? (input.dueDate ? input.dueDate.toLocaleDateString("ja-JP") : "別途協議"),
      HAS_BASE_CONTRACT: Boolean(getCustomFieldValue(input.issue, process.env.BACKLOG_FIELD_MASTER_CONTRACT_REF)),
      MASTER_CONTRACT_REF: getCustomFieldValue(input.issue, process.env.BACKLOG_FIELD_MASTER_CONTRACT_REF) ?? vendor?.masterContractRef ?? "",
      SPECIAL_TERMS: getCustomFieldValue(input.issue, process.env.BACKLOG_FIELD_SPECIAL_NOTES) ?? input.planningContext?.specialTerms ?? "",
      REMARKS: getCustomFieldValue(input.issue, process.env.BACKLOG_FIELD_REMARKS) ?? input.planningContext?.remarks ?? "",
      REMARKS_FIXED: getCustomFieldValue(input.issue, process.env.BACKLOG_FIELD_REMARKS) ?? input.planningContext?.remarks ?? "",
      REMARKS_FREE: input.legalRequest.notes ?? "",
      SHOW_ORDER_SIGN_SECTION: getBooleanFieldValue(input.issue, process.env.BACKLOG_FIELD_SHOW_ORDER_SIGN_SECTION),
      SHOW_SIGN_SECTION: getBooleanFieldValue(input.issue, process.env.BACKLOG_FIELD_SHOW_SIGN_SECTION),
      ACCEPT_METHOD: getCustomFieldValue(input.issue, process.env.BACKLOG_FIELD_ACCEPT_METHOD) ?? input.planningContext?.acceptMethod ?? "",
      ACCEPT_REPLY_DUE_DATE: getCustomFieldValue(input.issue, process.env.BACKLOG_FIELD_ACCEPT_REPLY_DUE_DATE) ?? input.planningContext?.acceptReplyDueDate ?? "",
      ACCEPT_BY_PERFORMANCE: getBooleanFieldValue(input.issue, process.env.BACKLOG_FIELD_ACCEPT_BY_PERFORMANCE),
      VENDOR_ACCEPT_DATE: getCustomFieldValue(input.issue, process.env.BACKLOG_FIELD_VENDOR_ACCEPT_DATE) ?? "",
      items: groupItems.map((item) => ({
        category: item.category ?? "イラスト制作",
        item_name: item.description,
        payment_method_display: getPaymentMethodLabel(normalizePaymentMethodCode(item.payMethod ?? "一括")),
        qty: item.quantity,
        unitPrice: item.unitPrice ?? item.latestAmount,
        amount: item.latestAmount,
        detailText: item.spec ?? "",
        payment_date: groupContext?.paymentDateLabel ?? input.planningContext?.paymentDateLabel ?? getPaymentDateLabel(item.latestDueDate),
        deliveryDateStr: formatDeliveryDate(item.latestDueDate),
        rightsLabel: input.planningContext?.rightsLabel ?? "発注書",
        transfer_fee: input.planningContext?.transferFee ?? "報酬に含む",
      })),
      grandTotalExTax: groupItems.reduce((sum, item) => sum + item.latestAmount, 0),
      ITEM_NAME: groupItems[0]?.description ?? "",
      FIRST_DRAFT_DEADLINE: formatPlanningFirstDraftDeadline(groupContext?.latestCompletionDate, input.planningContext?.firstDraftDeadlineLabel),
      FINAL_DEADLINE: groupContext?.finalDeadlineLabel ?? "別途協議",
    };
      rendered.push(await renderTemplate({
        templateKey: "order_planning",
        variables: common,
        outputBasename: `${input.issue.issueKey}_企画発注書_${vendorCode}`,
        driveFolderKey: resolveDriveFolderKey(input.legalRequest, groupStaff ?? input.staff),
      }));
  }
  return rendered;
}

async function renderStandardOrderDocumentsByVendor(input: {
  issue: BacklogIssue;
  legalRequest: Awaited<ReturnType<typeof ensureLegalRequest>>;
  items: Awaited<ReturnType<typeof getOrderItems>>;
  orderDate: Date;
  dueDate?: Date;
  hasBaseContract: boolean;
  staff: Awaited<ReturnType<typeof findStaffBySlackUserId>> | null;
  documentNumber: string;
}) {
  const groups = new Map<string, typeof input.items>();
  for (const item of input.items) {
    const vendorCode = item.vendorCode?.trim() || "UNKNOWN";
    const list = groups.get(vendorCode) ?? [];
    list.push(item);
    groups.set(vendorCode, list);
  }

  const rendered: Array<{ vendorCode: string; filename: string; driveUrl?: string; localPath: string }> = [];
  for (const [vendorCode, groupItems] of groups.entries()) {
    const vendor = await matchVendor({
      vendorCode: vendorCode !== "UNKNOWN" ? vendorCode : undefined,
      vendorName: getCustomFieldValue(input.issue, process.env.BACKLOG_FIELD_COUNTERPARTY) ?? input.legalRequest.counterparty,
    });
    const vendorRepresentative =
      getCustomFieldValue(input.issue, process.env.BACKLOG_FIELD_COUNTERPARTY_REP)
      ?? vendor?.vendorRepresentative
      ?? vendor?.contactName
      ?? "";

    const common = {
      ORDER_NO: groups.size === 1 ? input.documentNumber : `${input.documentNumber}-${vendorCode}`,
      ORDER_DATE_YEAR: String(input.orderDate.getFullYear()),
      ORDER_DATE_MONTH: String(input.orderDate.getMonth() + 1),
      ORDER_DATE_DAY: String(input.orderDate.getDate()),
      PROJECT_TITLE: getCustomFieldValue(input.issue, process.env.BACKLOG_FIELD_PROJECT_TITLE) ?? input.issue.summary,
      VENDOR_NAME: getCustomFieldValue(input.issue, process.env.BACKLOG_FIELD_COUNTERPARTY) ?? vendor?.vendorName ?? input.legalRequest.counterparty,
      VENDOR_SUFFIX: vendor?.vendorSuffix ?? "御中",
      VENDOR_ADDRESS: getCustomFieldValue(input.issue, process.env.BACKLOG_FIELD_COUNTERPARTY_ADDRESS) ?? vendor?.address ?? "",
      VENDOR_REPRESENTATIVE: vendorRepresentative,
      VENDOR_REPRESENTATIVE_SAMA: vendorRepresentative ? `${vendorRepresentative} 様` : "",
      VENDOR_EMAIL: vendor?.email ?? "",
      VENDOR_CONTACT_NAME: getCustomFieldValue(input.issue, process.env.BACKLOG_FIELD_VENDOR_ACCEPT_NAME) ?? vendor?.contactName ?? "",
      VENDOR_CONTACT_DEPARTMENT: getCustomFieldValue(input.issue, process.env.BACKLOG_FIELD_VENDOR_CONTACT_DEPARTMENT) ?? vendor?.contactDepartment ?? "",
      PARTY_A_NAME: input.staff?.partyAName ?? "株式会社アークライト",
      PARTY_A_ADDRESS: input.staff?.partyAAddress ?? "〒101-0052 東京都千代田区神田小川町1-2 風雲堂ビル2階",
      PARTY_A_REP: input.staff?.partyARep ?? "代表取締役 青柳昌行",
      STAFF_DEPARTMENT: input.staff?.department ?? "",
      STAFF_NAME: input.staff?.staffName ?? "",
      STAFF_PHONE: input.staff?.phone ?? "",
      STAFF_EMAIL: input.staff?.email ?? "",
      BANK_INFO: getCustomFieldValue(input.issue, process.env.BACKLOG_FIELD_BANK_INFO) ?? vendor?.bankInfo ?? "",
      BANK_NAME: getCustomFieldValue(input.issue, process.env.BACKLOG_FIELD_BANK_NAME) ?? vendor?.bankName ?? "",
      BRANCH_NAME: getCustomFieldValue(input.issue, process.env.BACKLOG_FIELD_BRANCH_NAME) ?? vendor?.branchName ?? "",
      ACCOUNT_TYPE: getCustomFieldValue(input.issue, process.env.BACKLOG_FIELD_ACCOUNT_TYPE) ?? vendor?.accountType ?? "",
      ACCOUNT_NUMBER: getCustomFieldValue(input.issue, process.env.BACKLOG_FIELD_ACCOUNT_NUMBER) ?? vendor?.accountNumber ?? "",
      ACCOUNT_HOLDER_KANA: getCustomFieldValue(input.issue, process.env.BACKLOG_FIELD_ACCOUNT_HOLDER_KANA) ?? vendor?.accountHolderKana ?? "",
      INVOICE_REGISTRATION_NUMBER: getCustomFieldValue(input.issue, process.env.BACKLOG_FIELD_INVOICE_REGISTRATION_NUMBER) ?? vendor?.invoiceRegistrationNumber ?? "",
      TRANSFER_FEE_PAYER: getCustomFieldValue(input.issue, process.env.BACKLOG_FIELD_TRANSFER_FEE_PAYER) ?? "",
      PAYMENT_TERMS: "明細参照",
      summaryPaymentTerms: "明細参照",
      summaryDeliveryDate: input.dueDate ? input.dueDate.toLocaleDateString("ja-JP") : "別途協議",
      HAS_BASE_CONTRACT: input.hasBaseContract,
      MASTER_CONTRACT_REF: getCustomFieldValue(input.issue, process.env.BACKLOG_FIELD_MASTER_CONTRACT_REF) ?? vendor?.masterContractRef ?? "",
      SPECIAL_TERMS: getCustomFieldValue(input.issue, process.env.BACKLOG_FIELD_SPECIAL_NOTES) ?? "",
      REMARKS: getCustomFieldValue(input.issue, process.env.BACKLOG_FIELD_REMARKS) ?? "",
      REMARKS_FIXED: getCustomFieldValue(input.issue, process.env.BACKLOG_FIELD_REMARKS) ?? "",
      REMARKS_FREE: input.legalRequest.notes ?? "",
      SHOW_ORDER_SIGN_SECTION: getBooleanFieldValue(input.issue, process.env.BACKLOG_FIELD_SHOW_ORDER_SIGN_SECTION),
      SHOW_SIGN_SECTION: getBooleanFieldValue(input.issue, process.env.BACKLOG_FIELD_SHOW_SIGN_SECTION),
      ACCEPT_METHOD: getCustomFieldValue(input.issue, process.env.BACKLOG_FIELD_ACCEPT_METHOD) ?? "",
      ACCEPT_REPLY_DUE_DATE: getCustomFieldValue(input.issue, process.env.BACKLOG_FIELD_ACCEPT_REPLY_DUE_DATE) ?? "",
      ACCEPT_BY_PERFORMANCE: getBooleanFieldValue(input.issue, process.env.BACKLOG_FIELD_ACCEPT_BY_PERFORMANCE),
      VENDOR_ACCEPT_DATE: getCustomFieldValue(input.issue, process.env.BACKLOG_FIELD_VENDOR_ACCEPT_DATE) ?? "",
      items: groupItems.map((item) => ({
        category: item.category ?? "イラスト制作",
        item_name: item.description,
        payment_method_display: getPaymentMethodLabel(normalizePaymentMethodCode(item.payMethod ?? "一括")),
        qty: item.quantity,
        unitPrice: item.unitPrice ?? item.latestAmount,
        amount: item.latestAmount,
        detailText: item.spec ?? "",
        payment_date: getPaymentDateLabel(item.latestDueDate),
        deliveryDateStr: formatDeliveryDate(item.latestDueDate),
        rightsLabel: "発注書",
        transfer_fee: "報酬に含む",
      })),
      grandTotalExTax: groupItems.reduce((sum, item) => sum + item.latestAmount, 0),
    };

    const outputBasename = groups.size === 1
      ? `${input.issue.issueKey}_発注書`
      : `${input.issue.issueKey}_発注書_${vendorCode}`;
    const renderedDoc = await renderOrderWithOptionalSpotTerms(
      common,
      outputBasename,
      input.hasBaseContract,
      resolveDriveFolderKey(input.legalRequest, input.staff),
    );
    rendered.push({
      vendorCode,
      filename: renderedDoc.filename,
      driveUrl: renderedDoc.driveUrl,
      localPath: renderedDoc.localPath,
    });
  }

  return rendered;
}

function getPaymentTermsLabel(dueDate?: Date): string {
  if (!dueDate) return "別途協議";
  return `${getPaymentDateLabel(dueDate)}払い`;
}

function getPaymentDateLabel(dueDate: Date): string {
  const date = new Date(dueDate);
  date.setMonth(date.getMonth() + 1, 20);
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

function formatDeliveryDate(dueDate: Date): string {
  return `${dueDate.getFullYear()}年${dueDate.getMonth() + 1}月${dueDate.getDate()}日`;
}

function formatPlanningFirstDraftDeadline(isoDate?: string, fallbackLabel?: string): string {
  const text = String(isoDate ?? "").trim();
  if (!text) return fallbackLabel || "別途協議";
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return fallbackLabel || text;
  return formatDeliveryDate(date);
}

function sanitizeDocumentNameSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_");
}

async function renderOrderWithOptionalSpotTerms(
  variables: Record<string, unknown>,
  outputBasename: string,
  hasBaseContract: boolean,
  driveFolderKey?: string,
) {
  if (hasBaseContract) {
    return renderTemplate({
      templateKey: "order",
      variables,
      outputBasename,
      driveFolderKey,
    });
  }

  const orderHtml = renderTemplateHtml("order", variables);
  const spotTermsHtml = renderTemplateHtml("spot_terms", variables);
  const combinedHtml = injectHtmlBeforeClosingBody(orderHtml, spotTermsHtml);

  return renderHtmlDocument({
    html: combinedHtml,
    outputBasename,
    driveFolderKey,
  });
}

function injectHtmlBeforeClosingBody(baseHtml: string, extraHtml: string): string {
  if (baseHtml.includes("</body>")) {
    return baseHtml.replace("</body>", `${extraHtml}\n</body>`);
  }
  return `${baseHtml}\n${extraHtml}`;
}

async function ensureLegalRequest(issue: BacklogIssue) {
  let legalRequest = await findLegalRequestByBacklogKey(issue.issueKey);
  if (!legalRequest) {
    const { createLegalRequest } = await import("../db/repository");
    legalRequest = await createLegalRequest({
      backlogIssueKey: issue.issueKey,
      slackUserId: `backlog:${issue.issueKey}`,
      contractType: issue.issueType?.name ?? "order",
      counterparty: getCustomFieldValue(issue, process.env.BACKLOG_FIELD_COUNTERPARTY) ?? "未設定",
      summary: issue.summary,
      notes: getCustomFieldValue(issue, process.env.BACKLOG_FIELD_REMARKS) ?? undefined,
    });
  }
  return legalRequest;
}

function getCustomFieldValue(issue: BacklogIssue, fieldIdRaw?: string): string | undefined {
  const raw = getBacklogCustomFieldValue(issue, fieldIdRaw);
  return raw || undefined;
}

function getBooleanFieldValue(issue: BacklogIssue, fieldIdRaw?: string): boolean {
  const raw = getCustomFieldValue(issue, fieldIdRaw);
  return raw === "true" || raw === "1" || raw === "on" || raw === "yes";
}

function getDateValue(raw?: string): Date | undefined {
  if (!raw) return undefined;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function resolvePlanningProjectTitle(
  issue: BacklogIssue,
  planningContext: ReturnType<typeof loadPlanningImportContext>,
): string {
  const backlogTitle = getCustomFieldValue(issue, process.env.BACKLOG_FIELD_PROJECT_TITLE);
  if (backlogTitle) return backlogTitle;

  const fileTitle = toFileStem(planningContext?.sourceFileName);
  if (fileTitle) return fileTitle;

  return planningContext?.projectTitle || issue.summary;
}

function toFileStem(sourceFileName?: string): string {
  const trimmed = String(sourceFileName ?? "").trim();
  if (!trimmed) return "";
  return trimmed.replace(/\.[^.]+$/, "");
}

async function findStaffBySlackUserIdWithFallback(rawSlackUserId?: string | null): Promise<StaffRecord | null> {
  const candidates = buildSlackUserIdCandidates(rawSlackUserId);
  for (const candidate of candidates) {
    const staff = await findStaffBySlackUserId(candidate);
    if (staff) return staff;
  }
  return null;
}

function buildSlackUserIdCandidates(rawSlackUserId?: string | null): string[] {
  const text = String(rawSlackUserId ?? "").trim();
  if (!text) return [];

  const mentionMatch = text.match(/^<@([A-Za-z0-9]+)(?:\|[^>]+)?>$/);
  const mentionId = mentionMatch?.[1] ?? "";
  const cleaned = (mentionId || text).trim();
  if (!cleaned) return [];

  return Array.from(new Set([
    cleaned,
    cleaned.toUpperCase(),
    cleaned.toLowerCase(),
  ]));
}
