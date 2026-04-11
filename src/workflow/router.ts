import { BacklogIssue } from "../backlog/client";
import {
  saveGeneratedDocuments,
  upsertIssueWorkflow,
} from "../db/repository";
import { enqueueGenerateDocumentsForIssue } from "../webhook/backlog";
import { findIssueWorkflow } from "../db/repository";
import { sendApprovalRequest, sendStampRequest } from "./approvals";
import { WORKFLOW_STATUS, isDocumentWorkflowIssue } from "./statusConfig";
import { SlackMessageClient } from "../slack/optionalClient";

export async function handlePolledIssueTransition(
  issue: BacklogIssue,
  slack: SlackMessageClient
): Promise<void> {
  await upsertIssueWorkflow(issue);

  const statusName = issue.status.name;
  const issueTypeName = issue.issueType?.name ?? "";

  if (!issueTypeName) return;

  if (statusName === WORKFLOW_STATUS.documentRequested && isDocumentWorkflowIssue(issueTypeName)) {
    const queued = await enqueueGenerateDocumentsForIssue(issue.issueKey, issueTypeName, {
      keyId: parseIssueKeyId(issue.issueKey),
      summary: issue.summary,
      status: issue.status,
      issueType: issue.issueType,
      customFields: issue.customFields,
      created: issue.created,
      updated: issue.updated,
    }, slack, "backlog-poller");

    if (!queued.executedInline) {
      return;
    }

    const docs = await inferGeneratedDocuments(issue.issueKey);
    if (docs.length > 0) {
      await saveGeneratedDocuments(issue.issueKey, docs);
    }

    const workflow = await findIssueWorkflow(issue.issueKey);
    await sendApprovalRequest(slack, issue, workflow?.primaryDocumentUrl ?? docs[0]?.url);
    return;
  }

  if (statusName === WORKFLOW_STATUS.stampPending) {
    const workflow = await findIssueWorkflow(issue.issueKey);
    await sendStampRequest(slack, issue, workflow?.primaryDocumentUrl ?? undefined);
  }
}

function parseIssueKeyId(issueKey: string): number | undefined {
  const match = issueKey.match(/-(\d+)$/);
  return match ? parseInt(match[1], 10) : undefined;
}

async function inferGeneratedDocuments(issueKey: string): Promise<Array<{ name: string; url?: string; localPath?: string }>> {
  const workflow = await findIssueWorkflow(issueKey);
  const existing = workflow?.generatedDocuments;
  if (Array.isArray(existing)) {
    return existing as Array<{ name: string; url?: string; localPath?: string }>;
  }
  return [];
}
