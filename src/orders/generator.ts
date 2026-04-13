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
  const staff = requesterSlackId ? await findStaffBySlackUserId(requesterSlackId) : null;
  const documentNumber = await resolveIssueDocumentNumber(backlog, issue, {
    partyAName: staff?.partyAName,
    departmentCode: staff?.departmentCode ?? undefined,
  });
  if (!getCustomFieldValue(issue, process.env.BACKLOG_FIELD_CONTRACT_NO) && process.env.BACKLOG_FIELD_CONTRACT_NO) {
    await backlog.updateCustomField(issue.issueKey, Number(process.env.BACKLOG_FIELD_CONTRACT_NO), documentNumber);
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

  const vendor = await matchVendor({
    vendorCode: getCustomFieldValue(issue, process.env.BACKLOG_FIELD_VENDOR_CODE),
    vendorName: getCustomFieldValue(issue, process.env.BACKLOG_FIELD_COUNTERPARTY) ?? legalRequest.counterparty,
  });
  const vendorRepresentative =
    getCustomFieldValue(issue, process.env.BACKLOG_FIELD_COUNTERPARTY_REP)
    ?? vendor?.vendorRepresentative
    ?? vendor?.contactName
    ?? "";

  const common = {
    ORDER_NO: documentNumber,
    ORDER_DATE_YEAR: String(orderDate.getFullYear()),
    ORDER_DATE_MONTH: String(orderDate.getMonth() + 1),
    ORDER_DATE_DAY: String(orderDate.getDate()),
    PROJECT_TITLE: getCustomFieldValue(issue, process.env.BACKLOG_FIELD_PROJECT_TITLE) ?? issue.summary,
    VENDOR_NAME: getCustomFieldValue(issue, process.env.BACKLOG_FIELD_COUNTERPARTY) ?? vendor?.vendorName ?? legalRequest.counterparty,
    VENDOR_SUFFIX: vendor?.vendorSuffix ?? "御中",
    VENDOR_ADDRESS: getCustomFieldValue(issue, process.env.BACKLOG_FIELD_COUNTERPARTY_ADDRESS) ?? vendor?.address ?? "",
    VENDOR_REPRESENTATIVE: vendorRepresentative,
    VENDOR_REPRESENTATIVE_SAMA: vendorRepresentative ? `${vendorRepresentative} 様` : "",
    VENDOR_EMAIL: vendor?.email ?? "",
    VENDOR_CONTACT_NAME: getCustomFieldValue(issue, process.env.BACKLOG_FIELD_VENDOR_ACCEPT_NAME) ?? vendor?.contactName ?? "",
    VENDOR_CONTACT_DEPARTMENT: getCustomFieldValue(issue, process.env.BACKLOG_FIELD_VENDOR_CONTACT_DEPARTMENT) ?? vendor?.contactDepartment ?? "",
    PARTY_A_NAME: staff?.partyAName ?? "株式会社アークライト",
    PARTY_A_ADDRESS: staff?.partyAAddress ?? "〒101-0052 東京都千代田区神田小川町1-2 風雲堂ビル2階",
    PARTY_A_REP: staff?.partyARep ?? "代表取締役 青柳昌行",
    STAFF_DEPARTMENT: staff?.department ?? "",
    STAFF_NAME: staff?.staffName ?? "",
    STAFF_PHONE: staff?.phone ?? "",
    STAFF_EMAIL: staff?.email ?? "",
    BANK_INFO: getCustomFieldValue(issue, process.env.BACKLOG_FIELD_BANK_INFO) ?? vendor?.bankInfo ?? "",
    BANK_NAME: getCustomFieldValue(issue, process.env.BACKLOG_FIELD_BANK_NAME) ?? vendor?.bankName ?? "",
    BRANCH_NAME: getCustomFieldValue(issue, process.env.BACKLOG_FIELD_BRANCH_NAME) ?? vendor?.branchName ?? "",
    ACCOUNT_TYPE: getCustomFieldValue(issue, process.env.BACKLOG_FIELD_ACCOUNT_TYPE) ?? vendor?.accountType ?? "",
    ACCOUNT_NUMBER: getCustomFieldValue(issue, process.env.BACKLOG_FIELD_ACCOUNT_NUMBER) ?? vendor?.accountNumber ?? "",
    ACCOUNT_HOLDER_KANA: getCustomFieldValue(issue, process.env.BACKLOG_FIELD_ACCOUNT_HOLDER_KANA) ?? vendor?.accountHolderKana ?? "",
    INVOICE_REGISTRATION_NUMBER: getCustomFieldValue(issue, process.env.BACKLOG_FIELD_INVOICE_REGISTRATION_NUMBER) ?? vendor?.invoiceRegistrationNumber ?? "",
    TRANSFER_FEE_PAYER: getCustomFieldValue(issue, process.env.BACKLOG_FIELD_TRANSFER_FEE_PAYER) ?? "",
    PAYMENT_TERMS: getPaymentTermsLabel(dueDate),
    summaryPaymentTerms: getPaymentTermsLabel(dueDate),
    summaryDeliveryDate: dueDate ? dueDate.toLocaleDateString("ja-JP") : "別途協議",
    HAS_BASE_CONTRACT: hasBaseContract,
    MASTER_CONTRACT_REF: getCustomFieldValue(issue, process.env.BACKLOG_FIELD_MASTER_CONTRACT_REF) ?? vendor?.masterContractRef ?? "",
    SPECIAL_TERMS: getCustomFieldValue(issue, process.env.BACKLOG_FIELD_SPECIAL_NOTES) ?? "",
    REMARKS: getCustomFieldValue(issue, process.env.BACKLOG_FIELD_REMARKS) ?? "",
    REMARKS_FIXED: getCustomFieldValue(issue, process.env.BACKLOG_FIELD_REMARKS) ?? "",
    REMARKS_FREE: legalRequest.notes ?? "",
    SHOW_ORDER_SIGN_SECTION: getBooleanFieldValue(issue, process.env.BACKLOG_FIELD_SHOW_ORDER_SIGN_SECTION),
    SHOW_SIGN_SECTION: getBooleanFieldValue(issue, process.env.BACKLOG_FIELD_SHOW_SIGN_SECTION),
    ACCEPT_METHOD: getCustomFieldValue(issue, process.env.BACKLOG_FIELD_ACCEPT_METHOD) ?? "",
    ACCEPT_REPLY_DUE_DATE: getCustomFieldValue(issue, process.env.BACKLOG_FIELD_ACCEPT_REPLY_DUE_DATE) ?? "",
    ACCEPT_BY_PERFORMANCE: getBooleanFieldValue(issue, process.env.BACKLOG_FIELD_ACCEPT_BY_PERFORMANCE),
    VENDOR_ACCEPT_DATE: getCustomFieldValue(issue, process.env.BACKLOG_FIELD_VENDOR_ACCEPT_DATE) ?? "",
    items: refreshedItems.map((item) => ({
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
    grandTotalExTax: refreshedItems.reduce((sum, item) => sum + item.latestAmount, 0),
  };

  const outputBasename = `${issue.issueKey}_${isPlanning ? "企画発注書" : "発注書"}`;

  const rendered = await renderOrderWithOptionalSpotTerms(
    common,
    outputBasename,
    hasBaseContract,
    resolveDriveFolderKey(legalRequest),
  );

  await saveGeneratedDocuments(issue.issueKey, [{
    name: isPlanning ? "order_planning" : "order",
    url: rendered.driveUrl,
    localPath: rendered.localPath,
  }]);

  await backlog.addComment(
    issue.issueKey,
    `## ✅ 発注書を生成しました\n\n- ${hasBaseContract ? "発注書" : "発注書（スポット取引条件書付き）"}: ${rendered.driveUrl ?? rendered.localPath}`
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
  const baseDocumentNumber = await resolveIssueDocumentNumber(backlog, input.issue, {
    partyAName: input.staff?.partyAName,
    departmentCode: input.staff?.departmentCode ?? undefined,
  });
  for (const item of input.items) {
    const vendorCode = item.vendorCode ?? "UNKNOWN";
    const list = groups.get(vendorCode) ?? [];
    list.push(item);
    groups.set(vendorCode, list);
  }

  const rendered = [];
  for (const [vendorCode, groupItems] of groups.entries()) {
    const groupContext = input.planningContext?.groups.find((group) => group.vendorCode === vendorCode);
    const groupStaff = groupContext?.requesterSlackUserId
      ? await findStaffBySlackUserId(groupContext.requesterSlackUserId)
      : input.staff;
    const vendor = await matchVendor({
      vendorCode: vendorCode !== "UNKNOWN" ? vendorCode : undefined,
      vendorName: groupContext?.vendorLookupValue ?? input.legalRequest.counterparty,
    });
    const vendorRepresentative =
      getCustomFieldValue(input.issue, process.env.BACKLOG_FIELD_COUNTERPARTY_REP)
      ?? vendor?.vendorRepresentative
      ?? vendor?.contactName
      ?? "";
    const common = {
      ORDER_NO: `${baseDocumentNumber}-${vendorCode}`,
      ORDER_DATE_YEAR: String(input.orderDate.getFullYear()),
      ORDER_DATE_MONTH: String(input.orderDate.getMonth() + 1),
      ORDER_DATE_DAY: String(input.orderDate.getDate()),
      PROJECT_TITLE: getCustomFieldValue(input.issue, process.env.BACKLOG_FIELD_PROJECT_TITLE) ?? input.planningContext?.projectTitle ?? input.issue.summary,
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
      STAFF_DEPARTMENT: groupStaff?.department ?? "",
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
      PAYMENT_TERMS: groupContext?.paymentTermsLabel ?? getPaymentTermsLabel(input.dueDate),
      summaryPaymentTerms: groupContext?.paymentTermsLabel ?? getPaymentTermsLabel(input.dueDate),
      summaryDeliveryDate: input.dueDate ? input.dueDate.toLocaleDateString("ja-JP") : "別途協議",
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
        deliveryDateStr: input.planningContext?.firstDraftDeadlineLabel ?? formatDeliveryDate(item.latestDueDate),
        rightsLabel: input.planningContext?.rightsLabel ?? "発注書",
        transfer_fee: input.planningContext?.transferFee ?? "報酬に含む",
      })),
      grandTotalExTax: groupItems.reduce((sum, item) => sum + item.latestAmount, 0),
      ITEM_NAME: groupItems[0]?.description ?? "",
      FIRST_DRAFT_DEADLINE: input.planningContext?.firstDraftDeadlineLabel ?? "完成",
      FINAL_DEADLINE: groupContext?.finalDeadlineLabel ?? "別途協議",
    };
      rendered.push(await renderTemplate({
        templateKey: "order_planning",
        variables: common,
        outputBasename: `${input.issue.issueKey}_企画発注書_${vendorCode}`,
        driveFolderKey: resolveDriveFolderKey(input.legalRequest),
      }));
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
