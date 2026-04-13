import fs from "fs";
import path from "path";
import { PlanningImportSettings } from "./planningImportSettings";

export interface PlanningImportGroupContext {
  vendorCode: string;
  vendorLookupValue?: string;
  requesterSlackUserId?: string;
  latestCompletionDate?: string;
  finalDeadlineLabel: string;
  paymentTermsLabel: string;
  paymentDateLabel: string;
  rowCount: number;
}

export interface PlanningImportContext {
  issueKey: string;
  sourceFileName?: string;
  projectTitle?: string;
  requesterSlackUserId?: string;
  orderDate?: string;
  specialTerms?: string;
  remarks?: string;
  acceptMethod?: string;
  acceptReplyDueDate?: string;
  firstDraftDeadlineLabel: string;
  paymentDateLabel: string;
  transferFeePayer: string;
  rightsLabel: string;
  transferFee: string;
  importedAt: string;
  rowCount: number;
  settingsVersion: number;
  groups: PlanningImportGroupContext[];
}

const CONTEXT_DIR = path.resolve(__dirname, "../../data/order-import-context");

export function savePlanningImportContext(context: PlanningImportContext): void {
  ensureContextDir();
  fs.writeFileSync(
    path.join(CONTEXT_DIR, `${sanitizeIssueKey(context.issueKey)}.json`),
    JSON.stringify(context, null, 2),
    "utf-8"
  );
}

export function loadPlanningImportContext(issueKey: string): PlanningImportContext | null {
  ensureContextDir();
  const filePath = path.join(CONTEXT_DIR, `${sanitizeIssueKey(issueKey)}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as PlanningImportContext;
  } catch {
    return null;
  }
}

export function buildPlanningImportContext(input: {
  issueKey: string;
  sourceFileName?: string;
  projectTitle?: string;
  specialTerms?: string;
  remarks?: string;
  acceptMethod?: string;
  acceptReplyDueDate?: string;
  groups: Array<{
    vendorCode: string;
    vendorLookupValue?: string;
    requesterSlackUserId?: string;
    completionDates: string[];
    finalDeadlineValues: string[];
    orderDateValues: string[];
    paymentDateValues: string[];
    rowCount: number;
  }>;
  rowCount: number;
  settings: PlanningImportSettings;
}): PlanningImportContext {
  return {
    issueKey: input.issueKey,
    sourceFileName: input.sourceFileName,
    projectTitle: input.projectTitle,
    requesterSlackUserId: collectUnique(input.groups.map((group) => group.requesterSlackUserId ?? "")).at(0),
    orderDate: pickLatestDate(input.groups.flatMap((group) => group.orderDateValues)),
    specialTerms: input.specialTerms,
    remarks: input.remarks,
    acceptMethod: input.acceptMethod,
    acceptReplyDueDate: input.acceptReplyDueDate,
    firstDraftDeadlineLabel: input.settings.constants.deliveryDateLabel,
    paymentDateLabel: input.settings.constants.paymentDateLabel,
    transferFeePayer: input.settings.constants.transferFeePayer,
    rightsLabel: input.settings.constants.rightsLabel,
    transferFee: input.settings.constants.transferFee,
    importedAt: new Date().toISOString(),
    rowCount: input.rowCount,
    settingsVersion: input.settings.version,
    groups: input.groups.map((group) => {
      const latestCompletionDate = pickLatestDate(group.completionDates);
      return {
        vendorCode: group.vendorCode,
        vendorLookupValue: group.vendorLookupValue,
        requesterSlackUserId: group.requesterSlackUserId,
        latestCompletionDate,
        finalDeadlineLabel: collectUnique(group.finalDeadlineValues).join(" / ") || input.settings.constants.finalDeadlineFallback,
        paymentTermsLabel: pickLatestDate(group.paymentDateValues)
          ? `${formatJapaneseDate(pickLatestDate(group.paymentDateValues)!)}払い`
          : latestCompletionDate
            ? `${formatNextMonth20(latestCompletionDate)}払い`
            : "別途協議",
        paymentDateLabel: pickLatestDate(group.paymentDateValues)
          ? formatJapaneseDate(pickLatestDate(group.paymentDateValues)!)
          : input.settings.constants.paymentDateLabel,
        rowCount: group.rowCount,
      };
    }),
  };
}

function ensureContextDir() {
  fs.mkdirSync(CONTEXT_DIR, { recursive: true });
}

function sanitizeIssueKey(issueKey: string): string {
  return issueKey.replace(/[^A-Za-z0-9_-]/g, "_");
}

function collectUnique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function pickLatestDate(values: string[]): string | undefined {
  return values
    .map((value) => value.trim())
    .filter(Boolean)
    .sort()
    .at(-1);
}

function formatNextMonth20(isoDate: string): string {
  const base = new Date(isoDate);
  base.setMonth(base.getMonth() + 1, 20);
  return `${base.getFullYear()}年${base.getMonth() + 1}月${base.getDate()}日`;
}

function formatJapaneseDate(isoDate: string): string {
  const date = new Date(isoDate);
  return Number.isNaN(date.getTime())
    ? isoDate
    : `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}
