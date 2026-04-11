import { BacklogIssue } from "./client";
import { getDefaultDriveFolderKey } from "../documents/driveFolders";

type LegalRequestLike = {
  slackUserId?: string | null;
  driveFolderKey?: string | null;
  counterparty?: string | null;
};

export function extractSlackUserId(raw?: string | null): string | undefined {
  const text = String(raw ?? "").trim();
  const match = text.match(/<@([A-Z0-9]+)>/);
  if (match?.[1]) {
    return match[1];
  }
  return text && !text.startsWith("backlog:") ? text : undefined;
}

export function resolveRequesterSlackId(
  issue: Pick<BacklogIssue, "customFields">,
  legalRequest?: LegalRequestLike | null,
): string | undefined {
  const fieldId = Number(process.env.BACKLOG_FIELD_REQUESTER);
  const fromBacklog = Number.isFinite(fieldId)
    ? extractSlackUserId(
        issue.customFields?.find((field) => field.fieldId === fieldId)?.value ?? undefined,
      )
    : undefined;
  if (fromBacklog) {
    return fromBacklog;
  }
  return extractSlackUserId(legalRequest?.slackUserId ?? undefined);
}

export function resolveDriveFolderKey(legalRequest?: LegalRequestLike | null): string {
  return String(legalRequest?.driveFolderKey ?? "").trim() || getDefaultDriveFolderKey();
}

export function resolveIssueCounterparty(
  issue: Pick<BacklogIssue, "customFields">,
  legalRequest?: LegalRequestLike | null,
): string {
  const fieldId = Number(process.env.BACKLOG_FIELD_COUNTERPARTY);
  const fromBacklog = Number.isFinite(fieldId)
    ? String(
        issue.customFields?.find((field) => field.fieldId === fieldId)?.value ?? "",
      ).trim()
    : "";
  if (fromBacklog) {
    return fromBacklog;
  }
  return String(legalRequest?.counterparty ?? "").trim();
}
