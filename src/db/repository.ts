/**
 * db/repository.ts
 * DBへの読み書きを集約したリポジトリ層
 *
 * Webhookハンドラーや文書生成モジュールはこのファイル経由でDBを操作する。
 * Prismaの型をそのまま返すので、呼び出し側で型補完が効く。
 */

import prisma from "./client";
import { RoyaltyCalculationResult } from "../documents/royalty";
import { Prisma } from "@prisma/client";
import { BacklogIssue, backlog } from "../backlog/client";

const WORK_EXECUTION_RUNNING_TTL_MS = 10 * 60 * 1000;

// ================================================================
// ライセンス契約（LicenseContract）
// ================================================================

/**
 * Backlog課題キーからライセンス契約を取得
 * （製造案件Webhookでの逆引きに使用）
 */
export async function findLicenseByBacklogKey(issueKey: string) {
  return prisma.licenseContract.findUnique({
    where: { backlogIssueKey: issueKey },
    include: {
      manufacturingEvents: {
        orderBy: { completionDate: "desc" },
        take: 5,
      },
    },
  });
}

export async function findManufacturingEventByBacklogIssueKey(issueKey: string) {
  return prisma.manufacturingEvent.findUnique({
    where: { backlogIssueKey: issueKey },
    include: {
      licenseContract: true,
      royaltyPayment: true,
    },
  });
}

/**
 * 台帳IDからライセンス契約を取得
 */
export async function findLicenseByLedgerId(ledgerId: string) {
  return prisma.licenseContract.findUnique({
    where: { ledgerId },
  });
}

/**
 * ライセンス契約を新規作成 or 更新（upsert）
 * Backlog Webhookでライセンス課題が起票されたときに呼ぶ
 */
export async function upsertLicenseContract(data: {
  backlogIssueKey: string;
  ledgerId: string;
  licensor: string;
  originalWork: string;
  licensorBankName?: string;
  licensorBranchName?: string;
  licensorAccountType?: string;
  licensorAccountNo?: string;
  licensorAccountName?: string;
  licensorInvoiceNum?: string;
  calcType?: string;
  royaltyRate?: number;
  distributionRate?: number;
  mgAmount?: number;
  paymentCycle?: string;
  reportingDays?: number;
  paymentDays?: number;
  currency?: string;
  licenseStartDate?: Date;
  licenseEndDate?: Date;
}) {
  const calcTypeMap: Record<string, Prisma.EnumRoyaltyCalcTypeFilter["equals"]> = {
    manufacturing: "MANUFACTURING",
    sales: "SALES",
    sublicense: "SUBLICENSE",
    fixed: "FIXED",
  };
  const cycleMap: Record<string, Prisma.EnumPaymentCycleFilter["equals"]> = {
    event: "EVENT",
    monthly: "MONTHLY",
    quarterly: "QUARTERLY",
    semi_annual: "SEMI_ANNUAL",
    annual: "ANNUAL",
  };

  const payload = {
    ledgerId: data.ledgerId,
    licensor: data.licensor,
    originalWork: data.originalWork,
    ...(data.licensorBankName !== undefined && { licensorBankName: data.licensorBankName }),
    ...(data.licensorBranchName !== undefined && { licensorBranchName: data.licensorBranchName }),
    ...(data.licensorAccountType !== undefined && { licensorAccountType: data.licensorAccountType }),
    ...(data.licensorAccountNo !== undefined && { licensorAccountNo: data.licensorAccountNo }),
    ...(data.licensorAccountName !== undefined && { licensorAccountName: data.licensorAccountName }),
    ...(data.licensorInvoiceNum !== undefined && { licensorInvoiceNum: data.licensorInvoiceNum }),
    royaltyRate: new Prisma.Decimal(data.royaltyRate ?? 0.08),
    ...(data.distributionRate !== undefined && {
      distributionRate: new Prisma.Decimal(data.distributionRate),
    }),
    ...(data.mgAmount !== undefined && { mgAmount: data.mgAmount }),
    ...(data.calcType && {
      calcType: (calcTypeMap[data.calcType] ?? "MANUFACTURING") as "MANUFACTURING",
    }),
    ...(data.paymentCycle && {
      paymentCycle: (cycleMap[data.paymentCycle] ?? "EVENT") as "EVENT",
    }),
    ...(data.reportingDays !== undefined && { reportingDays: data.reportingDays }),
    ...(data.paymentDays !== undefined && { paymentDays: data.paymentDays }),
    ...(data.currency && { currency: data.currency }),
    ...(data.licenseStartDate && { licenseStartDate: data.licenseStartDate }),
    ...(data.licenseEndDate && { licenseEndDate: data.licenseEndDate }),
  };

  return prisma.licenseContract.upsert({
    where: { backlogIssueKey: data.backlogIssueKey },
    create: { backlogIssueKey: data.backlogIssueKey, ...payload },
    update: payload,
  });
}

/**
 * MG消化額を加算して更新（アトミックな加算でレースコンディションを防ぐ）
 */
export async function incrementMgConsumed(licenseContractId: string, amount: number) {
  return prisma.licenseContract.update({
    where: { id: licenseContractId },
    data: { mgConsumedToDate: { increment: amount } },
  });
}

// ================================================================
// 製造案件（ManufacturingEvent）
// ================================================================

/**
 * ロイヤリティ計算結果をDBに保存
 * Backlogフィールドへの依存を排除し、DBを正とする
 */
export async function saveManufacturingEvent(
  result: RoyaltyCalculationResult,
  licenseContractId: string
) {
  const event = await prisma.manufacturingEvent.upsert({
    where: { backlogIssueKey: result.manufacturingIssueKey },
    create: {
      backlogIssueKey: result.manufacturingIssueKey,
      licenseContractId,
      productName: result.productName,
      edition: result.edition,
      completionDate: new Date(result.completionDateRaw),
      quantity: result.quantity,
      sampleQuantity: result.sampleQuantity,
      billableQuantity: result.billableQuantity,
      msrp: result.msrp,
      currency: result.currency,
      royaltyRate: new Prisma.Decimal(result.royaltyRate),
      grossRoyalty: result.grossRoyalty,
      mgConsumedThisTime: result.mgConsumedThisTime,
      actualRoyalty: result.actualRoyalty,
      taxRate: result.taxRate,
      taxAmount: result.taxAmount,
      totalPayment: result.totalPayment,
      reportingDeadline: new Date(result.reportingDeadlineRaw),
      paymentDueDate: new Date(result.paymentDueDateRaw),
      status: "CALCULATED",
    },
    update: {
      status: "CALCULATED",
      royaltyRate: new Prisma.Decimal(result.royaltyRate),
      grossRoyalty: result.grossRoyalty,
      mgConsumedThisTime: result.mgConsumedThisTime,
      actualRoyalty: result.actualRoyalty,
      taxAmount: result.taxAmount,
      totalPayment: result.totalPayment,
    },
  });

  // 支払記録を作成（ゼロ払いも含めて記録）
  await prisma.royaltyPayment.upsert({
    where: { manufacturingEventId: event.id },
    create: {
      manufacturingEventId: event.id,
      licenseContractId,
      paymentDueDate: new Date(result.paymentDueDateRaw),
      reportingDeadline: new Date(result.reportingDeadlineRaw),
      totalAmount: result.totalPayment,
      currency: result.currency,
      status: result.actualRoyalty === 0 ? "ZERO" : "UNPAID",
    },
    update: {
      totalAmount: result.totalPayment,
      status: result.actualRoyalty === 0 ? "ZERO" : "UNPAID",
    },
  });

  return event;
}

/**
 * Drive保管URLを製造案件に記録
 */
export async function updateManufacturingEventUrls(
  backlogIssueKey: string,
  urls: { royaltyReportUrl?: string; paymentNoticeUrl?: string }
) {
  return prisma.manufacturingEvent.update({
    where: { backlogIssueKey },
    data: urls,
  });
}

// ================================================================
// ロイヤリティ支払（RoyaltyPayment）
// ================================================================

/**
 * 期限超過した未払いを OVERDUE に更新するバッチ処理
 * 定期実行（毎朝 cron）で呼ぶ
 */
export async function markOverduePayments() {
  const now = new Date();
  const result = await prisma.royaltyPayment.updateMany({
    where: {
      status: "UNPAID",
      paymentDueDate: { lt: now },
    },
    data: { status: "OVERDUE" },
  });
  return result.count;
}

/**
 * 直近の未払い・期限超過一覧を取得（Slackアラート用）
 */
export async function getUpcomingPayments(daysAhead = 14) {
  const deadline = new Date();
  deadline.setDate(deadline.getDate() + daysAhead);

  return prisma.royaltyPayment.findMany({
    where: {
      status: { in: ["UNPAID", "OVERDUE"] },
      paymentDueDate: { lte: deadline },
    },
    include: {
      manufacturingEvent: { select: { productName: true, edition: true, backlogIssueKey: true } },
      licenseContract: { select: { licensor: true, originalWork: true, backlogIssueKey: true } },
    },
    orderBy: { paymentDueDate: "asc" },
  });
}

/**
 * 支払を消込（支払済みに更新）
 */
export async function markPaymentPaid(
  manufacturingEventBacklogKey: string,
  paidAmount: number,
  transferRef?: string
) {
  const event = await prisma.manufacturingEvent.findUnique({
    where: { backlogIssueKey: manufacturingEventBacklogKey },
  });
  if (!event) throw new Error(`製造案件が見つかりません: ${manufacturingEventBacklogKey}`);

  return prisma.royaltyPayment.update({
    where: { manufacturingEventId: event.id },
    data: {
      status: "PAID",
      paidAt: new Date(),
      paidAmount,
      transferRef,
    },
  });
}

export interface OrderDueReminderTarget {
  id: string;
  itemNo: number;
  description: string;
  latestDueDate: Date;
  status: string;
  legalRequest: {
    backlogIssueKey: string;
    slackUserId: string;
    contractType: string;
    counterparty: string;
    summary: string;
  };
}

export async function getUpcomingOrderDueReminderTargets(daysAhead = 7): Promise<OrderDueReminderTarget[]> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const deadline = new Date(today);
  deadline.setDate(deadline.getDate() + daysAhead);

  return prisma.orderItem.findMany({
    where: {
      latestDueDate: { lte: deadline },
      status: { in: ["PENDING", "PARTIAL", "REJECTED"] },
      legalRequest: {
        contractType: { in: ["purchase_order", "planning_order"] },
        status: { not: "CANCELLED" },
      },
    },
    select: {
      id: true,
      itemNo: true,
      description: true,
      latestDueDate: true,
      status: true,
      legalRequest: {
        select: {
          backlogIssueKey: true,
          slackUserId: true,
          contractType: true,
          counterparty: true,
          summary: true,
        },
      },
    },
    orderBy: [{ latestDueDate: "asc" }, { legalRequestId: "asc" }, { itemNo: "asc" }],
  });
}

export async function listIssueWorkflowsByIssueKeys(issueKeys: string[]) {
  if (issueKeys.length === 0) return [];
  return prisma.issueWorkflow.findMany({
    where: {
      backlogIssueKey: { in: issueKeys },
    },
    select: {
      backlogIssueKey: true,
      currentStatusName: true,
    },
  });
}

export async function findOrderDueReminderLog(
  orderItemId: string,
  reminderType: string,
  reminderDate: Date
) {
  return prisma.orderDueReminderLog.findFirst({
    where: {
      orderItemId,
      reminderType,
      reminderDate,
    },
  });
}

export async function createOrderDueReminderLog(
  orderItemId: string,
  reminderType: string,
  reminderDate: Date
) {
  return prisma.orderDueReminderLog.create({
    data: {
      orderItemId,
      reminderType,
      reminderDate,
    },
  });
}

// ================================================================
// 法務依頼（LegalRequest）
// ================================================================

export async function createLegalRequest(data: {
  backlogIssueKey: string;
  slackUserId: string;
  slackChannelId?: string;
  contractType: string;
  driveFolderKey?: string;
  counterparty: string;
  summary: string;
  deadline?: Date;
  notes?: string;
}) {
  return prisma.legalRequest.upsert({
    where: { backlogIssueKey: data.backlogIssueKey },
    create: data,
    update: { status: "RECEIVED", driveFolderKey: data.driveFolderKey },
  });
}

/**
 * Backlog課題キーから法務依頼を取得（納品報告の親課題逆引きに使用）
 */
export async function findLegalRequestByBacklogKey(backlogIssueKey: string) {
  return prisma.legalRequest.findUnique({
    where: { backlogIssueKey },
  });
}

export interface ParentIssueSearchResult {
  issueKey: string;
  category: "order" | "license";
  contractType: string;
  label: string;
  summary: string;
  counterparty?: string | null;
  detail?: string | null;
}

export async function searchParentIssueCandidates(query: string, limit = 8): Promise<ParentIssueSearchResult[]> {
  const q = query.trim();
  if (!q) return [];
  const normalizedQuery = normalizeSearchText(q);
  const fetchSize = Math.max(limit * 8, 50);

  const [orderRequests, licenseContracts, licenseWorkflows, orderWorkflows] = await Promise.all([
    prisma.legalRequest.findMany({
      where: {
        contractType: { in: ["purchase_order", "planning_order"] },
      },
      orderBy: { updatedAt: "desc" },
      take: fetchSize,
    }),
    prisma.licenseContract.findMany({
      orderBy: { updatedAt: "desc" },
      take: fetchSize,
    }),
    prisma.issueWorkflow.findMany({
      where: {
        issueTypeName: { in: ["ライセンス契約", "個別利用許諾条件"] },
      },
      orderBy: { updatedAt: "desc" },
      take: fetchSize,
    }),
    prisma.issueWorkflow.findMany({
      where: {
        issueTypeName: { in: ["発注書", "企画発注書"] },
      },
      orderBy: { updatedAt: "desc" },
      take: fetchSize,
    }),
  ]);

  const results: ParentIssueSearchResult[] = [
    ...orderRequests.map((item) => ({
      issueKey: item.backlogIssueKey,
      category: "order" as const,
      contractType: item.contractType,
      label: item.contractType === "planning_order" ? "企画発注書" : "発注書",
      summary: item.summary,
      counterparty: item.counterparty,
      detail: item.deadline ? `希望期限 ${item.deadline.toISOString().slice(0, 10)}` : null,
    })),
    ...licenseContracts.map((item) => ({
      issueKey: item.backlogIssueKey,
      category: "license" as const,
      contractType: "license",
      label: "ライセンス契約",
      summary: item.originalWork || item.licensor,
      counterparty: item.licensor,
      detail: item.ledgerId,
    })),
    ...licenseWorkflows.map((item) => ({
      issueKey: item.backlogIssueKey,
      category: "license" as const,
      contractType: item.issueTypeName === "個別利用許諾条件" ? "license_schedule" : "license",
      label: item.issueTypeName || "ライセンス案件",
      summary: item.currentSummary || item.backlogIssueKey,
      counterparty: null,
      detail: item.currentStatusName || null,
    })),
    ...orderWorkflows.map((item) => ({
      issueKey: item.backlogIssueKey,
      category: "order" as const,
      contractType: item.issueTypeName === "企画発注書" ? "planning_order" : "purchase_order",
      label: item.issueTypeName || "発注案件",
      summary: item.currentSummary || item.backlogIssueKey,
      counterparty: null,
      detail: item.currentStatusName || null,
    })),
  ];

  const deduped = new Map<string, ParentIssueSearchResult>();
  for (const result of results) {
    if (!deduped.has(result.issueKey)) {
      deduped.set(result.issueKey, result);
    }
  }

  return Array.from(deduped.values())
    .filter((result) => matchesParentIssueSearch(result, normalizedQuery))
    .slice(0, limit);
}

function matchesParentIssueSearch(result: ParentIssueSearchResult, normalizedQuery: string): boolean {
  const haystacks = [
    result.issueKey,
    result.label,
    result.summary,
    result.counterparty ?? "",
    result.detail ?? "",
  ];
  return haystacks.some((value) => normalizeSearchText(value).includes(normalizedQuery));
}

function normalizeSearchText(value: string): string {
  return toKatakana(value)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[‐‑‒–—―ーｰ]/g, "-");
}

function toKatakana(value: string): string {
  return value.replace(/[\u3041-\u3096]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) + 0x60)
  );
}

// ================================================================
// マスタ（Vendor / Staff）
// ================================================================

export async function upsertVendor(data: {
  vendorCode: string;
  vendorName: string;
  tradeName?: string;
  penName?: string;
  vendorSuffix?: string;
  entityType?: string;
  withholdingEnabled?: boolean;
  aliases?: string[];
  address?: string;
  phone?: string;
  email?: string;
  contactDepartment?: string;
  contactName?: string;
  vendorRepresentative?: string;
  bankInfo?: string;
  bankName?: string;
  branchName?: string;
  accountType?: string;
  accountNumber?: string;
  accountHolderKana?: string;
  isInvoiceIssuer?: boolean;
  invoiceRegistrationNumber?: string;
  masterContractRef?: string;
}) {
  return prisma.vendor.upsert({
    where: { vendorCode: data.vendorCode },
    create: {
      vendorCode: data.vendorCode,
      vendorName: data.vendorName,
      tradeName: data.tradeName,
      penName: data.penName,
      vendorSuffix: data.vendorSuffix ?? "御中",
      entityType: data.entityType ?? "corporation",
      withholdingEnabled: data.withholdingEnabled ?? false,
      aliases: data.aliases ?? [],
      address: data.address,
      phone: data.phone,
      email: data.email,
      contactDepartment: data.contactDepartment,
      contactName: data.contactName,
      vendorRepresentative: data.vendorRepresentative,
      bankInfo: data.bankInfo,
      bankName: data.bankName,
      branchName: data.branchName,
      accountType: data.accountType,
      accountNumber: data.accountNumber,
      accountHolderKana: data.accountHolderKana,
      isInvoiceIssuer: data.isInvoiceIssuer ?? false,
      invoiceRegistrationNumber: data.invoiceRegistrationNumber,
      masterContractRef: data.masterContractRef,
    },
    update: {
      vendorName: data.vendorName,
      tradeName: data.tradeName,
      penName: data.penName,
      vendorSuffix: data.vendorSuffix ?? "御中",
      entityType: data.entityType ?? "corporation",
      withholdingEnabled: data.withholdingEnabled ?? false,
      aliases: data.aliases ?? [],
      address: data.address,
      phone: data.phone,
      email: data.email,
      contactDepartment: data.contactDepartment,
      contactName: data.contactName,
      vendorRepresentative: data.vendorRepresentative,
      bankInfo: data.bankInfo,
      bankName: data.bankName,
      branchName: data.branchName,
      accountType: data.accountType,
      accountNumber: data.accountNumber,
      accountHolderKana: data.accountHolderKana,
      isInvoiceIssuer: data.isInvoiceIssuer ?? false,
      invoiceRegistrationNumber: data.invoiceRegistrationNumber,
      masterContractRef: data.masterContractRef,
    },
  });
}

export async function findVendorByCode(vendorCode: string) {
  return prisma.vendor.findUnique({
    where: { vendorCode },
  });
}

export async function listVendors(params?: { query?: string; limit?: number }) {
  const query = String(params?.query ?? "").trim();
  const take = Math.min(Math.max(params?.limit ?? 50, 1), 200);
  const aliasMatchedCodes = query
    ? (await prisma.vendor.findMany({
        where: {
          aliases: {
            has: query,
          },
        },
        select: {
          vendorCode: true,
        },
        take,
      })).map((row) => row.vendorCode)
    : [];

  return prisma.vendor.findMany({
    where: query
      ? {
          OR: [
            { vendorCode: { contains: query, mode: "insensitive" } },
            { vendorName: { contains: query, mode: "insensitive" } },
            { tradeName: { contains: query, mode: "insensitive" } },
            { penName: { contains: query, mode: "insensitive" } },
            { email: { contains: query, mode: "insensitive" } },
            { contactName: { contains: query, mode: "insensitive" } },
            { vendorRepresentative: { contains: query, mode: "insensitive" } },
            { contactDepartment: { contains: query, mode: "insensitive" } },
            { invoiceRegistrationNumber: { contains: query, mode: "insensitive" } },
            { masterContractRef: { contains: query, mode: "insensitive" } },
            ...(aliasMatchedCodes.length > 0
              ? [{ vendorCode: { in: aliasMatchedCodes } }]
              : []),
          ],
        }
      : undefined,
    orderBy: [{ updatedAt: "desc" }, { vendorCode: "asc" }],
    take,
  });
}

export async function matchVendor(input: { vendorCode?: string; vendorName?: string }) {
  if (input.vendorCode) {
    const byCode = await findVendorByCode(input.vendorCode);
    if (byCode) return byCode;
  }

  const normalizedName = input.vendorName?.trim();
  if (!normalizedName) return null;

  return prisma.vendor.findFirst({
    where: {
      OR: [
        { vendorName: normalizedName },
        { tradeName: normalizedName },
        { penName: normalizedName },
        { aliases: { has: normalizedName } },
      ],
    },
  });
}

export async function upsertStaff(data: {
  slackUserId: string;
  staffName: string;
  department?: string;
  departmentCode?: string;
  phone?: string;
  email?: string;
  partyAName?: string;
  partyAAddress?: string;
  partyARep?: string;
}) {
  return prisma.staff.upsert({
    where: { slackUserId: data.slackUserId },
    create: {
      slackUserId: data.slackUserId,
      staffName: data.staffName,
      department: data.department,
      departmentCode: data.departmentCode,
      phone: data.phone,
      email: data.email,
      partyAName: data.partyAName ?? "株式会社アークライト",
      partyAAddress: data.partyAAddress ?? "〒101-0052 東京都千代田区神田小川町1-2 風雲堂ビル2階",
      partyARep: data.partyARep ?? "代表取締役 青柳昌行",
    },
    update: {
      staffName: data.staffName,
      department: data.department,
      departmentCode: data.departmentCode,
      phone: data.phone,
      email: data.email,
      partyAName: data.partyAName ?? "株式会社アークライト",
      partyAAddress: data.partyAAddress ?? "〒101-0052 東京都千代田区神田小川町1-2 風雲堂ビル2階",
      partyARep: data.partyARep ?? "代表取締役 青柳昌行",
    },
  });
}

export async function findStaffBySlackUserId(slackUserId: string) {
  return prisma.staff.findUnique({
    where: { slackUserId },
  });
}

export async function listStaff(params?: { query?: string; limit?: number }) {
  const query = String(params?.query ?? "").trim();
  const take = Math.min(Math.max(params?.limit ?? 50, 1), 200);

  return prisma.staff.findMany({
    where: query
      ? {
          OR: [
            { slackUserId: { contains: query, mode: "insensitive" } },
            { staffName: { contains: query, mode: "insensitive" } },
            { department: { contains: query, mode: "insensitive" } },
            { departmentCode: { contains: query, mode: "insensitive" } },
            { email: { contains: query, mode: "insensitive" } },
            { phone: { contains: query, mode: "insensitive" } },
          ],
        }
      : undefined,
    orderBy: [{ updatedAt: "desc" }, { slackUserId: "asc" }],
    take,
  });
}

export async function listStaffDepartments() {
  const rows = await prisma.staff.findMany({
    where: {
      department: {
        not: null,
      },
    },
    select: {
      department: true,
    },
    distinct: ["department"],
    orderBy: [{ department: "asc" }],
  });

  return rows
    .map((row) => row.department?.trim())
    .filter((department): department is string => Boolean(department));
}

export async function upsertDepartmentWorkflowRule(data: {
  department: string;
  postChannelId?: string;
  approverSlackId?: string;
  stampOperatorSlackId?: string;
  managerSlackId?: string;
  isActive?: boolean;
}) {
  return prisma.departmentWorkflowRule.upsert({
    where: { department: data.department },
    create: {
      department: data.department,
      postChannelId: data.postChannelId,
      approverSlackId: data.approverSlackId,
      stampOperatorSlackId: data.stampOperatorSlackId,
      managerSlackId: data.managerSlackId,
      isActive: data.isActive ?? true,
    },
    update: {
      postChannelId: data.postChannelId,
      approverSlackId: data.approverSlackId,
      stampOperatorSlackId: data.stampOperatorSlackId,
      managerSlackId: data.managerSlackId,
      isActive: data.isActive ?? true,
    },
  });
}

export async function listDepartmentWorkflowRules() {
  return prisma.departmentWorkflowRule.findMany({
    orderBy: [{ department: "asc" }],
  });
}

export async function findDepartmentWorkflowRule(department: string) {
  return prisma.departmentWorkflowRule.findUnique({
    where: { department },
  });
}

export async function updateLegalRequestStatus(
  backlogIssueKey: string,
  status: "IN_PROGRESS" | "COMPLETED" | "CANCELLED",
  urls?: { inspectionCertUrl?: string; paymentNoticeUrl?: string }
) {
  return prisma.legalRequest.update({
    where: { backlogIssueKey },
    data: { status, ...urls },
  });
}

// ================================================================
// ダッシュボード用集計クエリ
// ================================================================

/**
 * ライセンス台帳サマリー（Slack /法務一覧 等で使用）
 */
export async function getLicenseDashboard() {
  const [totalContracts, activeContracts, unpaidPayments, overduePayments] =
    await Promise.all([
      prisma.licenseContract.count(),
      prisma.licenseContract.count({ where: { status: "ACTIVE" } }),
      prisma.royaltyPayment.count({ where: { status: "UNPAID" } }),
      prisma.royaltyPayment.count({ where: { status: "OVERDUE" } }),
    ]);

  return { totalContracts, activeContracts, unpaidPayments, overduePayments };
}

export async function getAdminDashboardSnapshot(limit = 6) {
  const [recentWorkflows, statusGroups, recentStatusItems, recentGeneratedDocs, attentionWorkflows, syncFailures, recentBacklogSyncRuns, workflowSummaries, liveBacklogIssues] = await Promise.all([
    prisma.issueWorkflow.findMany({
      orderBy: [{ updatedAt: "desc" }],
      take: limit,
      select: {
        backlogIssueKey: true,
        issueTypeName: true,
        currentStatusName: true,
        currentSummary: true,
        updatedAt: true,
        approvalRequestedAt: true,
        approvedAt: true,
        rejectedAt: true,
        stampRequestedAt: true,
        stampedAt: true,
        esignCompletedAt: true,
        stampRejectedAt: true,
        primaryDocumentUrl: true,
      },
    }),
    prisma.backlogSyncState.groupBy({
      by: ["statusName"],
      _count: {
        _all: true,
      },
      orderBy: {
        _count: {
          statusName: "desc",
        },
      },
    }),
    prisma.backlogSyncState.findMany({
      orderBy: [{ updatedAt: "desc" }],
      take: Math.max(limit * 5, 50),
      select: {
        backlogIssueKey: true,
        issueTypeName: true,
        statusName: true,
        updatedAt: true,
      },
    }),
    prisma.issueWorkflow.findMany({
      where: {
        generatedDocuments: {
          not: Prisma.JsonNull,
        },
      },
      orderBy: [{ updatedAt: "desc" }],
      take: limit,
      select: {
        backlogIssueKey: true,
        issueTypeName: true,
        currentSummary: true,
        updatedAt: true,
        generatedDocuments: true,
      },
    }),
    prisma.issueWorkflow.findMany({
      where: {
        OR: [
          { rejectedAt: { not: null } },
          { stampRejectedAt: { not: null } },
          {
            approvalRequestedAt: { not: null },
            approvedAt: null,
            rejectedAt: null,
          },
          {
            stampRequestedAt: { not: null },
            stampedAt: null,
            esignCompletedAt: null,
            stampRejectedAt: null,
          },
        ],
      },
      orderBy: [{ updatedAt: "desc" }],
      take: limit,
      select: {
        backlogIssueKey: true,
        issueTypeName: true,
        currentStatusName: true,
        currentSummary: true,
        updatedAt: true,
        approvalRequestedAt: true,
        rejectedAt: true,
        stampRequestedAt: true,
        stampRejectedAt: true,
      },
    }),
    prisma.backlogSyncState.findMany({
      where: {
        lastProcessingError: {
          not: null,
        },
      },
      orderBy: [{ updatedAt: "desc" }],
      take: limit,
      select: {
        backlogIssueKey: true,
        issueTypeName: true,
        statusName: true,
        updatedAt: true,
        lastProcessingError: true,
      },
    }),
    prisma.backlogSyncRun.findMany({
      orderBy: [{ createdAt: "desc" }],
      take: limit,
      select: {
        triggerSource: true,
        status: true,
        issueCount: true,
        changedCount: true,
        processedCount: true,
        failedCount: true,
        bootstrapped: true,
        errorMessage: true,
        createdAt: true,
      },
    }),
    prisma.issueWorkflow.findMany({
      select: {
        backlogIssueKey: true,
        currentSummary: true,
      },
    }),
    backlog.listAllIssues().catch(() => [] as BacklogIssue[]),
  ]);

  const workflowSummaryMap = new Map(
    workflowSummaries.map((item) => [item.backlogIssueKey, item.currentSummary]),
  );
  const liveStatusSummary = summarizeBacklogStatusSummary(liveBacklogIssues);
  const liveRecentStatusItems = liveBacklogIssues.map((item) => ({
    issueKey: item.issueKey,
    issueTypeName: item.issueType?.name ?? null,
    currentStatusName: item.status?.name ?? null,
    summary: item.summary || (workflowSummaryMap.get(item.issueKey) ?? null),
    updatedAt: new Date(item.updated),
  }));

  return {
    recentWorkflows: recentWorkflows.map((workflow) => ({
      issueKey: workflow.backlogIssueKey,
      issueTypeName: workflow.issueTypeName,
      currentStatusName: workflow.currentStatusName,
      summary: workflow.currentSummary,
      updatedAt: workflow.updatedAt,
      activityLabel: resolveWorkflowActivityLabel(workflow),
      hasPrimaryDocument: Boolean(workflow.primaryDocumentUrl),
    })),
    statusSummary: liveStatusSummary.length > 0
      ? liveStatusSummary
      : statusGroups.map((group) => ({
        statusName: group.statusName ?? "未設定",
        count: group._count._all,
      })),
    recentStatusItems: (liveRecentStatusItems.length > 0
      ? liveRecentStatusItems
      : recentStatusItems.map((item) => ({
        issueKey: item.backlogIssueKey,
        issueTypeName: item.issueTypeName,
        currentStatusName: item.statusName,
        summary: workflowSummaryMap.get(item.backlogIssueKey) ?? null,
        updatedAt: item.updatedAt,
      }))).slice(0, Math.max(limit * 5, 50)),
    recentGeneratedDocuments: recentGeneratedDocs.flatMap((workflow) => {
      const documents = Array.isArray(workflow.generatedDocuments)
        ? workflow.generatedDocuments as Array<{ name?: string; url?: string; localPath?: string }>
        : [];
      return documents.slice(0, 3).map((document) => ({
        issueKey: workflow.backlogIssueKey,
        issueTypeName: workflow.issueTypeName,
        summary: workflow.currentSummary,
        updatedAt: workflow.updatedAt,
        name: document.name ?? "document",
        href: document.url ?? document.localPath ?? "",
      }));
    }).slice(0, Math.max(limit * 2, 8)),
    attentionItems: [
      ...attentionWorkflows.map((workflow) => ({
        issueKey: workflow.backlogIssueKey,
        issueTypeName: workflow.issueTypeName,
        statusName: workflow.currentStatusName,
        summary: workflow.currentSummary,
        updatedAt: workflow.updatedAt,
        reason: resolveAttentionReason(workflow),
        kind: "workflow" as const,
      })),
      ...syncFailures.map((item) => ({
        issueKey: item.backlogIssueKey,
        issueTypeName: item.issueTypeName,
        statusName: item.statusName,
        summary: item.lastProcessingError,
        updatedAt: item.updatedAt,
        reason: "Backlog同期エラー",
        kind: "sync" as const,
      })),
    ].slice(0, Math.max(limit * 2, 8)),
    recentBacklogSyncRuns: recentBacklogSyncRuns.map((item) => ({
      triggerSource: item.triggerSource,
      status: item.status,
      issueCount: item.issueCount,
      changedCount: item.changedCount,
      processedCount: item.processedCount,
      failedCount: item.failedCount,
      bootstrapped: item.bootstrapped,
      errorMessage: item.errorMessage,
      createdAt: item.createdAt,
    })),
  };
}

function summarizeBacklogStatusSummary(items: BacklogIssue[]): Array<{ statusName: string; count: number }> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const statusName = String(item.status?.name ?? "未設定");
    counts.set(statusName, (counts.get(statusName) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .map(([statusName, count]) => ({ statusName, count }))
    .sort((left, right) => right.count - left.count);
}

function resolveWorkflowActivityLabel(workflow: {
  approvalRequestedAt: Date | null;
  approvedAt: Date | null;
  rejectedAt: Date | null;
  stampRequestedAt: Date | null;
  stampedAt: Date | null;
  esignCompletedAt: Date | null;
  stampRejectedAt: Date | null;
  primaryDocumentUrl: string | null;
}) {
  if (workflow.esignCompletedAt) return "電子締結完了";
  if (workflow.stampedAt) return "押印完了";
  if (workflow.stampRejectedAt) return "押印差戻し";
  if (workflow.stampRequestedAt) return "押印依頼中";
  if (workflow.approvedAt) return "承認済み";
  if (workflow.rejectedAt) return "承認差戻し";
  if (workflow.approvalRequestedAt) return "承認依頼中";
  if (workflow.primaryDocumentUrl) return "文書生成済み";
  return "最近更新";
}

function resolveAttentionReason(workflow: {
  approvalRequestedAt: Date | null;
  rejectedAt: Date | null;
  stampRequestedAt: Date | null;
  stampRejectedAt: Date | null;
}) {
  if (workflow.stampRejectedAt) return "押印差戻し";
  if (workflow.rejectedAt) return "承認差戻し";
  if (workflow.stampRequestedAt) return "押印待ち";
  if (workflow.approvalRequestedAt) return "承認待ち";
  return "要確認";
}

// ================================================================
// Backlogポーリング同期状態
// ================================================================

export async function upsertBacklogSyncState(
  issue: Pick<BacklogIssue, "id" | "issueKey" | "updated" | "status" | "issueType">
) {
  return prisma.backlogSyncState.upsert({
    where: { backlogIssueKey: issue.issueKey },
    create: {
      backlogIssueId: issue.id,
      backlogIssueKey: issue.issueKey,
      issueTypeName: issue.issueType?.name,
      statusId: issue.status.id,
      statusName: issue.status.name,
      lastBacklogUpdatedAt: new Date(issue.updated),
      lastPolledAt: new Date(),
    },
    update: {
      backlogIssueId: issue.id,
      issueTypeName: issue.issueType?.name,
      statusId: issue.status.id,
      statusName: issue.status.name,
      lastBacklogUpdatedAt: new Date(issue.updated),
      lastPolledAt: new Date(),
      lastProcessingError: null,
    },
  });
}

export async function markBacklogSyncProcessed(issueKey: string) {
  return prisma.backlogSyncState.update({
    where: { backlogIssueKey: issueKey },
    data: {
      lastProcessedAt: new Date(),
      lastProcessingError: null,
    },
  });
}

export async function markBacklogSyncFailed(issueKey: string, error: string) {
  return prisma.backlogSyncState.update({
    where: { backlogIssueKey: issueKey },
    data: {
      lastProcessingError: error.slice(0, 2000),
    },
  });
}

export async function findBacklogSyncState(issueKey: string) {
  return prisma.backlogSyncState.findUnique({
    where: { backlogIssueKey: issueKey },
  });
}

export async function createBacklogSyncRun(input: {
  triggerSource: string;
  status: "SUCCEEDED" | "FAILED";
  issueCount?: number;
  changedCount?: number;
  processedCount?: number;
  failedCount?: number;
  bootstrapped?: boolean;
  errorMessage?: string | null;
}) {
  return prisma.backlogSyncRun.create({
    data: {
      triggerSource: input.triggerSource,
      status: input.status,
      issueCount: input.issueCount ?? 0,
      changedCount: input.changedCount ?? 0,
      processedCount: input.processedCount ?? 0,
      failedCount: input.failedCount ?? 0,
      bootstrapped: input.bootstrapped ?? false,
      errorMessage: input.errorMessage ? input.errorMessage.slice(0, 2000) : null,
    },
  });
}

// ================================================================
// 課題ワークフロー
// ================================================================

export async function upsertIssueWorkflow(
  issue: Pick<BacklogIssue, "id" | "issueKey" | "summary" | "status" | "issueType">
) {
  return prisma.issueWorkflow.upsert({
    where: { backlogIssueKey: issue.issueKey },
    create: {
      backlogIssueKey: issue.issueKey,
      backlogIssueId: issue.id,
      issueTypeName: issue.issueType?.name,
      currentStatusId: issue.status.id,
      currentStatusName: issue.status.name,
      currentSummary: issue.summary,
    },
    update: {
      backlogIssueId: issue.id,
      issueTypeName: issue.issueType?.name,
      currentStatusId: issue.status.id,
      currentStatusName: issue.status.name,
      currentSummary: issue.summary,
    },
  });
}

export async function findIssueWorkflow(issueKey: string) {
  return prisma.issueWorkflow.findUnique({
    where: { backlogIssueKey: issueKey },
  });
}

export async function saveIssueSlackThread(issueKey: string, slackChannel: string, slackTs: string) {
  return prisma.issueWorkflow.upsert({
    where: { backlogIssueKey: issueKey },
    create: {
      backlogIssueKey: issueKey,
      requestSlackChannel: slackChannel,
      requestSlackTs: slackTs,
    },
    update: {
      requestSlackChannel: slackChannel,
      requestSlackTs: slackTs,
    },
  });
}

export async function findIssueWorkflowByStampThread(stampSlackChannel: string, stampSlackTs: string) {
  return prisma.issueWorkflow.findFirst({
    where: {
      stampSlackChannel,
      stampSlackTs,
    },
  });
}

export async function findIssueWorkflowByIssueKey(issueKey: string) {
  return prisma.issueWorkflow.findUnique({
    where: { backlogIssueKey: issueKey },
  });
}

export async function findWorkExecutionByKey(executionKey: string) {
  return prisma.workExecution.findUnique({
    where: { executionKey },
  });
}

export async function beginWorkExecution(input: {
  executionKey: string;
  workType: string;
  issueKey: string;
  source: string;
}) {
  const existing = await findWorkExecutionByKey(input.executionKey);
  const now = new Date();

  if (existing?.status === "SUCCEEDED") {
    return {
      state: "duplicate_succeeded" as const,
      record: existing,
    };
  }

  if (
    existing?.status === "RUNNING"
    && existing.startedAt
    && now.getTime() - existing.startedAt.getTime() < WORK_EXECUTION_RUNNING_TTL_MS
  ) {
    return {
      state: "duplicate_running" as const,
      record: existing,
    };
  }

  const record = await prisma.workExecution.upsert({
    where: { executionKey: input.executionKey },
    create: {
      executionKey: input.executionKey,
      workType: input.workType,
      issueKey: input.issueKey,
      source: input.source,
      status: "RUNNING",
      attemptCount: 1,
      startedAt: now,
      finishedAt: null,
      lastError: null,
    },
    update: {
      workType: input.workType,
      issueKey: input.issueKey,
      source: input.source,
      status: "RUNNING",
      attemptCount: { increment: 1 },
      startedAt: now,
      finishedAt: null,
      lastError: null,
    },
  });

  return {
    state: "started" as const,
    record,
  };
}

export async function completeWorkExecution(executionKey: string) {
  return prisma.workExecution.update({
    where: { executionKey },
    data: {
      status: "SUCCEEDED",
      finishedAt: new Date(),
      lastError: null,
    },
  });
}

export async function failWorkExecution(executionKey: string, error: string) {
  return prisma.workExecution.update({
    where: { executionKey },
    data: {
      status: "FAILED",
      finishedAt: new Date(),
      lastError: error.slice(0, 4000),
    },
  });
}

export async function saveIssueDocumentDraft(issueKey: string, draft: Record<string, unknown>) {
  const jsonDraft = draft as Prisma.InputJsonValue;
  return prisma.issueWorkflow.upsert({
    where: { backlogIssueKey: issueKey },
    create: {
      backlogIssueKey: issueKey,
      documentDraft: jsonDraft,
      documentDraftUpdatedAt: new Date(),
    },
    update: {
      documentDraft: jsonDraft,
      documentDraftUpdatedAt: new Date(),
    },
  });
}

export async function saveGeneratedDocuments(
  issueKey: string,
  documents: Array<{ name: string; url?: string; localPath?: string }>
) {
  const primaryDocumentUrl = documents.find((doc) => doc.url)?.url ?? null;

  return prisma.issueWorkflow.upsert({
    where: { backlogIssueKey: issueKey },
    create: {
      backlogIssueKey: issueKey,
      generatedDocuments: documents,
      primaryDocumentUrl,
    },
    update: {
      generatedDocuments: documents,
      primaryDocumentUrl,
    },
  });
}

export async function markApprovalRequested(input: {
  issueKey: string;
  approverSlackId?: string;
  approvalSlackChannel?: string;
  approvalSlackTs?: string;
}) {
  return prisma.issueWorkflow.upsert({
    where: { backlogIssueKey: input.issueKey },
    create: {
      backlogIssueKey: input.issueKey,
      approverSlackId: input.approverSlackId,
      approvalSlackChannel: input.approvalSlackChannel,
      approvalSlackTs: input.approvalSlackTs,
      approvalRequestedAt: new Date(),
    },
    update: {
      approverSlackId: input.approverSlackId,
      approvalSlackChannel: input.approvalSlackChannel,
      approvalSlackTs: input.approvalSlackTs,
      approvalRequestedAt: new Date(),
      approvedAt: null,
      approvedBySlackId: null,
      rejectedAt: null,
      rejectedReason: null,
    },
  });
}

export async function markIssueApproved(issueKey: string, approvedBySlackId: string) {
  return prisma.issueWorkflow.update({
    where: { backlogIssueKey: issueKey },
    data: {
      approvedAt: new Date(),
      approvedBySlackId,
      rejectedAt: null,
      rejectedReason: null,
    },
  });
}

export async function markIssueRejected(issueKey: string, rejectedReason: string) {
  return prisma.issueWorkflow.update({
    where: { backlogIssueKey: issueKey },
    data: {
      rejectedAt: new Date(),
      rejectedReason,
      approvedAt: null,
      approvedBySlackId: null,
    },
  });
}

export async function markStampRequested(input: {
  issueKey: string;
  stampType: "PHYSICAL" | "ELECTRONIC";
  stampOperatorSlackId?: string;
  stampSlackChannel?: string;
  stampSlackTs?: string;
}) {
  return prisma.issueWorkflow.upsert({
    where: { backlogIssueKey: input.issueKey },
    create: {
      backlogIssueKey: input.issueKey,
      stampRequestedAt: new Date(),
      stampType: input.stampType,
      stampOperatorSlackId: input.stampOperatorSlackId,
      stampSlackChannel: input.stampSlackChannel,
      stampSlackTs: input.stampSlackTs,
      ...(input.stampType === "ELECTRONIC" ? { esignRequestedAt: new Date() } : {}),
    },
    update: {
      stampRequestedAt: new Date(),
      stampType: input.stampType,
      stampOperatorSlackId: input.stampOperatorSlackId,
      stampSlackChannel: input.stampSlackChannel,
      stampSlackTs: input.stampSlackTs,
      stampedAt: null,
      stampedDriveUrl: null,
      stampRejectedAt: null,
      stampRejectedReason: null,
      stampCompletedBySlackId: null,
      ...(input.stampType === "ELECTRONIC"
        ? { esignRequestedAt: new Date(), esignCompletedAt: null, esignDriveUrl: null }
        : { esignRequestedAt: null, esignCompletedAt: null, esignDriveUrl: null }),
    },
  });
}

export async function markPhysicalStampCompleted(
  issueKey: string,
  stampedDriveUrl: string,
  stampCompletedBySlackId?: string
) {
  return prisma.issueWorkflow.update({
    where: { backlogIssueKey: issueKey },
    data: {
      stampedAt: new Date(),
      stampedDriveUrl,
      stampRejectedAt: null,
      stampRejectedReason: null,
      stampCompletedBySlackId,
    },
  });
}

export async function markElectronicSignCompleted(
  issueKey: string,
  esignDriveUrl: string,
  stampCompletedBySlackId?: string
) {
  return prisma.issueWorkflow.update({
    where: { backlogIssueKey: issueKey },
    data: {
      esignCompletedAt: new Date(),
      esignDriveUrl,
      stampRejectedAt: null,
      stampRejectedReason: null,
      stampCompletedBySlackId,
    },
  });
}

export async function markStampRejected(
  issueKey: string,
  stampRejectedReason: string,
  stampCompletedBySlackId?: string
) {
  return prisma.issueWorkflow.update({
    where: { backlogIssueKey: issueKey },
    data: {
      stampRejectedAt: new Date(),
      stampRejectedReason,
      stampCompletedBySlackId,
      stampedAt: null,
      stampedDriveUrl: null,
      esignCompletedAt: null,
      esignDriveUrl: null,
    },
  });
}

export async function listApprovalReminderTargets(hours = 24) {
  const threshold = new Date(Date.now() - hours * 60 * 60 * 1000);
  return prisma.issueWorkflow.findMany({
    where: {
      approvalRequestedAt: { lte: threshold },
      approvedAt: null,
      rejectedAt: null,
    },
    orderBy: { approvalRequestedAt: "asc" },
  });
}

export async function listStampReminderTargets(hours = 48) {
  const threshold = new Date(Date.now() - hours * 60 * 60 * 1000);
  return prisma.issueWorkflow.findMany({
    where: {
      stampRequestedAt: { lte: threshold },
      stampedAt: null,
      esignCompletedAt: null,
      stampRejectedAt: null,
    },
    orderBy: { stampRequestedAt: "asc" },
  });
}

export async function listStampWorkflows() {
  return prisma.issueWorkflow.findMany({
    where: {
      OR: [
        { stampRequestedAt: { not: null } },
        { stampedAt: { not: null } },
        { esignCompletedAt: { not: null } },
        { stampRejectedAt: { not: null } },
      ],
    },
    orderBy: [{ updatedAt: "desc" }],
  });
}
