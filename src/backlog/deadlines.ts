import { BacklogIssue } from "./client";
import { formatDateJa, parseDateRaw } from "../payments/schedule";

export interface ResolvedRoyaltyDeadlines {
  reportingDeadlineRaw: string;
  reportingDeadline: string;
  paymentDueDateRaw: string;
  paymentDueDate: string;
  issueDueDateRaw?: string;
  source: "backlog" | "calculated";
}

export function resolveOrderDeliveryDeadline(issue: Pick<BacklogIssue, "customFields" | "dueDate">): Date | undefined {
  const raw = firstValidDate(
    getField(issue, process.env.BACKLOG_FIELD_DELIVERY_DATE),
    issue.dueDate,
    getField(issue, process.env.BACKLOG_FIELD_DEADLINE),
  );
  if (!raw) return undefined;
  return parseDateSafe(raw);
}

export function resolveRoyaltyDeadlines(
  issue: Pick<BacklogIssue, "customFields" | "dueDate">,
  calculated: { reportingDeadlineRaw: string; paymentDueDateRaw: string },
): ResolvedRoyaltyDeadlines {
  const backlogReporting = firstValidDate(getField(issue, process.env.BACKLOG_FIELD_S1_REPORT_DUE));
  const backlogPayment = firstValidDate(
    getField(issue, process.env.BACKLOG_FIELD_S1_PAYMENT_DUE),
    issue.dueDate,
  );

  const reportingDeadlineRaw = backlogReporting ?? normalizeDateOnly(calculated.reportingDeadlineRaw) ?? calculated.reportingDeadlineRaw;
  const paymentDueDateRaw = backlogPayment ?? normalizeDateOnly(calculated.paymentDueDateRaw) ?? calculated.paymentDueDateRaw;
  const issueDueDateRaw = backlogPayment ?? paymentDueDateRaw;
  const source = backlogReporting || backlogPayment ? "backlog" : "calculated";

  return {
    reportingDeadlineRaw,
    reportingDeadline: formatResolvedDate(reportingDeadlineRaw),
    paymentDueDateRaw,
    paymentDueDate: formatResolvedDate(paymentDueDateRaw),
    issueDueDateRaw,
    source,
  };
}

export function buildRoyaltyDeadlineCustomFields(deadlines: {
  reportingDeadlineRaw: string;
  paymentDueDateRaw: string;
}): Record<string, string> {
  const entries: Record<string, string> = {};
  if (process.env.BACKLOG_FIELD_S1_REPORT_DUE && deadlines.reportingDeadlineRaw) {
    entries[process.env.BACKLOG_FIELD_S1_REPORT_DUE] = deadlines.reportingDeadlineRaw;
  }
  if (process.env.BACKLOG_FIELD_S1_PAYMENT_DUE && deadlines.paymentDueDateRaw) {
    entries[process.env.BACKLOG_FIELD_S1_PAYMENT_DUE] = deadlines.paymentDueDateRaw;
  }
  return entries;
}

function firstValidDate(...values: Array<string | null | undefined>): string | undefined {
  for (const value of values) {
    const normalized = normalizeDateOnly(value);
    if (normalized) return normalized;
  }
  return undefined;
}

function getField(issue: Pick<BacklogIssue, "customFields">, envKey?: string): string {
  if (!envKey) return "";
  return issue.customFields?.find((field) => field.fieldId === Number(envKey))?.value ?? "";
}

function parseDateSafe(raw: string): Date | undefined {
  try {
    return parseDateRaw(raw);
  } catch {
    return undefined;
  }
}

function formatResolvedDate(raw: string): string {
  const parsed = parseDateSafe(raw);
  return parsed ? formatDateJa(parsed) : raw;
}

function normalizeDateOnly(raw?: string | null): string | undefined {
  const value = String(raw ?? "").trim();
  if (!value) return undefined;
  const match = value.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (match) {
    return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, "0")}-${String(parsed.getDate()).padStart(2, "0")}`;
}
