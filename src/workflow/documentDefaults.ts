import { BacklogClient, BacklogIssue } from "../backlog/client";

type IssueLike = Pick<BacklogIssue, "issueKey" | "created" | "customFields" | "issueType">;

export function getBacklogCustomFieldValue(issue: IssueLike, envKey?: string): string {
  if (!envKey) return "";
  return issue.customFields?.find((field) => field.fieldId === Number(envKey))?.value ?? "";
}

export function resolveIssueDocumentDate(issue: IssueLike): string {
  return (
    getBacklogCustomFieldValue(issue, process.env.BACKLOG_FIELD_CONTRACT_DATE) ||
    getBacklogCustomFieldValue(issue, process.env.BACKLOG_FIELD_ORDER_DATE) ||
    issue.created?.slice(0, 10) ||
    ""
  );
}

export async function resolveIssueDocumentNumber(
  backlogClient: BacklogClient,
  issue: IssueLike,
  context?: {
    partyAName?: string;
    departmentCode?: string;
  }
): Promise<string> {
  const existing = getBacklogCustomFieldValue(issue, process.env.BACKLOG_FIELD_CONTRACT_NO);
  if (existing) return existing;
  return generateNextDocumentNumber(backlogClient, issue, context);
}

export async function generateNextDocumentNumber(
  backlogClient: BacklogClient,
  issue: IssueLike,
  context?: {
    partyAName?: string;
    departmentCode?: string;
  }
): Promise<string> {
  const documentDate = resolveIssueDocumentDate(issue);
  const yyyymm = extractYearMonth(documentDate);
  const prefix = [
    getDocumentPrefix(issue.issueType?.name ?? ""),
    resolveCompanyCode(context?.partyAName),
    resolveDepartmentCode(context?.departmentCode),
    yyyymm,
  ].join("_");

  const issues = await backlogClient.listAllIssues();
  const currentIssueKey = issue.issueKey;
  const maxSerial = issues.reduce((max, current) => {
    if (current.issueKey === currentIssueKey) return max;
    const contractNo = getBacklogCustomFieldValue(current, process.env.BACKLOG_FIELD_CONTRACT_NO);
    const serial = extractSerial(contractNo, prefix);
    return serial > max ? serial : max;
  }, 0);

  return `${prefix}_${String(maxSerial + 1).padStart(3, "0")}`;
}

export function resolveCompanyCode(partyAName?: string): string {
  const normalized = String(partyAName ?? "").trim();
  if (normalized.includes("新紀元社")) return "SKG";
  if (normalized.includes("アークライト")) return "ARC";
  return process.env.DOCUMENT_DEFAULT_COMPANY_CODE?.trim() || "ARC";
}

export function resolveDepartmentCode(departmentCode?: string): string {
  const normalized = String(departmentCode ?? "").trim().toUpperCase();
  return normalized || process.env.DOCUMENT_DEFAULT_DEPARTMENT_CODE?.trim() || "GEN";
}

function getDocumentPrefix(issueTypeName: string): string {
  if (
    issueTypeName === (process.env.BACKLOG_ISSUE_TYPE_PURCHASE_ORDER ?? "発注書") ||
    issueTypeName === (process.env.BACKLOG_ISSUE_TYPE_PLANNING_ORDER ?? "企画発注書") ||
    issueTypeName === (process.env.BACKLOG_ISSUE_TYPE_PUBLISHING_ORDER ?? "出版発注書")
  ) {
    return "PO";
  }
  if (issueTypeName === (process.env.BACKLOG_ISSUE_TYPE_LICENSE_SCHEDULE ?? "個別利用許諾条件")) {
    return "LIC";
  }
  if (issueTypeName === (process.env.BACKLOG_ISSUE_TYPE_IP_OVERSEAS_AMENDMENT ?? "海外IP契約（変更合意）")) {
    return "IPA";
  }
  if (issueTypeName === (process.env.BACKLOG_ISSUE_TYPE_IP_OVERSEAS_MASTER ?? "海外IP契約（基本契約）")) {
    return "IPM";
  }
  return "C";
}

function extractYearMonth(documentDate?: string): string {
  const text = String(documentDate ?? "").trim();
  const match = text.match(/^(\d{4})-(\d{2})/);
  if (match) return `${match[1]}${match[2]}`;
  const now = new Date();
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function extractSerial(contractNo: string, prefix: string): number {
  const match = contractNo.match(new RegExp(`^${escapeRegExp(prefix)}_(\\d+)$`));
  return match ? Number(match[1]) : 0;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
