import { backlog, BacklogIssue } from "../backlog/client";
import { resolveRequesterSlackId } from "../backlog/issueContext";
import {
  findDepartmentWorkflowRule,
  findIssueWorkflow,
  findLegalRequestByBacklogKey,
  findStaffBySlackUserId,
  markApprovalRequested,
  markIssueApproved,
  markIssueRejected,
  markElectronicSignCompleted,
  markPhysicalStampCompleted,
  markStampRejected,
  markStampRequested,
} from "../db/repository";
import { postIssueAnswerback } from "../slack/threading";
import { WORKFLOW_STATUS } from "./statusConfig";
import { getWorkflowSettings } from "./workflowSettings";
import { SlackMessageClient } from "../slack/optionalClient";

export async function sendApprovalRequest(
  slack: SlackMessageClient,
  issue: BacklogIssue,
  primaryDocumentUrl?: string
): Promise<void> {
  const assignment = await resolveWorkflowAssignment(issue);
  const approverSlackId = assignment.approverSlackId;
  if (!approverSlackId) {
    console.warn(`[Approval] APPROVER_SLACK_ID が未設定のため承認依頼をスキップ: ${issue.issueKey}`);
    return;
  }

  const workflow = await findIssueWorkflow(issue.issueKey);
  if (workflow?.approvedAt || workflow?.approvalRequestedAt) {
    return;
  }

  const res = await slack.chat.postMessage({
    channel: approverSlackId,
    text: `📄 文書承認リクエスト: ${issue.issueKey}`,
    blocks: buildApprovalBlocks(issue, primaryDocumentUrl, assignment),
  });

  await markApprovalRequested({
    issueKey: issue.issueKey,
    approverSlackId,
    approvalSlackChannel: approverSlackId,
    approvalSlackTs: res.ts,
  });

  const statusId = await backlog.findStatusIdByName(WORKFLOW_STATUS.approvalPending);
  if (statusId) {
    await backlog.updateStatus(issue.issueKey, statusId);
  }
}

export async function approveIssue(
  slack: SlackMessageClient,
  issueKey: string,
  approvedBySlackId: string
): Promise<void> {
  await markIssueApproved(issueKey, approvedBySlackId);

  const statusId =
    (await backlog.findStatusIdByName(WORKFLOW_STATUS.cloudSignPreparing)) ??
    (await backlog.findStatusIdByName(WORKFLOW_STATUS.counterpartyPending)) ??
    (await backlog.findStatusIdByName(WORKFLOW_STATUS.stampPending));
  if (statusId) {
    await backlog.updateStatus(issueKey, statusId);
  }

  await postIssueAnswerback(slack, issueKey, {
    text: `✅ 承認完了: ${issueKey}`,
  });
}

export async function rejectIssue(
  slack: SlackMessageClient,
  issueKey: string,
  rejectedReason: string
): Promise<void> {
  await markIssueRejected(issueKey, rejectedReason);

  const statusId =
    (await backlog.findStatusIdByName(WORKFLOW_STATUS.documentRequested)) ??
    (await backlog.findStatusIdByName(WORKFLOW_STATUS.draft));
  if (statusId) {
    await backlog.updateStatus(issueKey, statusId);
  }

  await postIssueAnswerback(slack, issueKey, {
    text: `❌ 差戻し: ${issueKey}\n${rejectedReason}`,
  });
}

export async function sendStampRequest(
  slack: SlackMessageClient,
  issue: BacklogIssue,
  primaryDocumentUrl?: string
): Promise<void> {
  const assignment = await resolveWorkflowAssignment(issue);
  const stampOperatorSlackId = assignment.stampOperatorSlackId;
  if (!stampOperatorSlackId) {
    console.warn(`[Stamp] STAMP_OPERATOR_SLACK_ID が未設定のため押印依頼をスキップ: ${issue.issueKey}`);
    return;
  }

  const workflow = await findIssueWorkflow(issue.issueKey);
  if (workflow?.stampedAt || workflow?.stampRequestedAt) {
    return;
  }

  const res = await slack.chat.postMessage({
    channel: stampOperatorSlackId,
    text: `🔏 押印リクエスト: ${issue.issueKey}`,
    blocks: buildStampBlocks(issue, primaryDocumentUrl, assignment),
  });

  await markStampRequested({
    issueKey: issue.issueKey,
    stampType: "PHYSICAL",
    stampOperatorSlackId,
    stampSlackChannel: stampOperatorSlackId,
    stampSlackTs: res.ts,
  });

  const statusId = await backlog.findStatusIdByName(WORKFLOW_STATUS.stampPending);
  if (statusId) {
    await backlog.updateStatus(issue.issueKey, statusId);
  }
}

export async function chooseStampType(
  issueKey: string,
  stampType: "PHYSICAL" | "ELECTRONIC"
) {
  const workflow = await findIssueWorkflow(issueKey);
  await markStampRequested({
    issueKey,
    stampType,
    stampOperatorSlackId: workflow?.stampOperatorSlackId ?? getWorkflowSettings().stampOperatorSlackId ?? process.env.STAMP_OPERATOR_SLACK_ID,
  });
}

export async function previewWorkflowAssignmentForSlackUser(requesterSlackId?: string): Promise<{
  postChannelId?: string;
  approverSlackId?: string;
  stampOperatorSlackId?: string;
  managerSlackId?: string;
  department?: string;
  requesterSlackId?: string;
  source: "department_rule" | "default_settings" | "environment";
}> {
  return resolveWorkflowAssignmentCore(requesterSlackId);
}

async function resolveWorkflowAssignment(issue: BacklogIssue): Promise<{
  postChannelId?: string;
  approverSlackId?: string;
  stampOperatorSlackId?: string;
  managerSlackId?: string;
  department?: string;
  requesterSlackId?: string;
  source: "department_rule" | "default_settings" | "environment";
}> {
  const legalRequest = await findLegalRequestByBacklogKey(issue.issueKey);
  return resolveWorkflowAssignmentCore(resolveRequesterSlackId(issue, legalRequest));
}

async function resolveWorkflowAssignmentCore(requesterSlackId?: string): Promise<{
  postChannelId?: string;
  approverSlackId?: string;
  stampOperatorSlackId?: string;
  managerSlackId?: string;
  department?: string;
  requesterSlackId?: string;
  source: "department_rule" | "default_settings" | "environment";
}> {
  const defaults = getWorkflowSettings();
  const envApprover = process.env.APPROVER_SLACK_ID || undefined;
  const envStampOperator = process.env.STAMP_OPERATOR_SLACK_ID || undefined;
  const defaultPostChannel = defaults.intakeChannelId || process.env.SLACK_LEGAL_CHANNEL || undefined;
  const defaultApprover = defaults.approverSlackId || envApprover;
  const defaultStampOperator = defaults.stampOperatorSlackId || envStampOperator;

  if (!requesterSlackId) {
    return {
      postChannelId: defaultPostChannel,
      approverSlackId: defaultApprover,
      stampOperatorSlackId: defaultStampOperator,
      source: defaults.approverSlackId || defaults.stampOperatorSlackId ? "default_settings" : "environment",
    };
  }

  const staff = await findStaffBySlackUserId(requesterSlackId);
  const department = staff?.department?.trim();
  if (!department) {
    return {
      postChannelId: defaultPostChannel,
      approverSlackId: defaultApprover,
      stampOperatorSlackId: defaultStampOperator,
      requesterSlackId,
      source: defaults.approverSlackId || defaults.stampOperatorSlackId ? "default_settings" : "environment",
    };
  }

  const rule = await findDepartmentWorkflowRule(department);
  if (rule?.isActive && (rule.postChannelId || rule.approverSlackId || rule.stampOperatorSlackId || rule.managerSlackId)) {
    return {
      postChannelId: rule.postChannelId || defaultPostChannel,
      approverSlackId: rule.approverSlackId || defaultApprover,
      stampOperatorSlackId: rule.stampOperatorSlackId || defaultStampOperator,
      managerSlackId: rule.managerSlackId || undefined,
      department,
      requesterSlackId,
      source: "department_rule",
    };
  }

  return {
    postChannelId: defaultPostChannel,
    approverSlackId: defaultApprover,
    stampOperatorSlackId: defaultStampOperator,
    managerSlackId: undefined,
    department,
    requesterSlackId,
    source: defaults.approverSlackId || defaults.stampOperatorSlackId ? "default_settings" : "environment",
  };
}

export async function completeStamp(
  slack: SlackMessageClient,
  issueKey: string,
  input: {
    stampType: "PHYSICAL" | "ELECTRONIC";
    documentUrl: string;
    completedBySlackId?: string;
  }
) {
  if (input.stampType === "ELECTRONIC") {
    await markElectronicSignCompleted(issueKey, input.documentUrl, input.completedBySlackId);
  } else {
    await markPhysicalStampCompleted(issueKey, input.documentUrl, input.completedBySlackId);
  }

  const statusId =
    (await backlog.findStatusIdByName(WORKFLOW_STATUS.signed)) ??
    (await backlog.findStatusIdByName(WORKFLOW_STATUS.completed));
  if (statusId) {
    await backlog.updateStatus(issueKey, statusId);
  }

  if (process.env.SLACK_LEGAL_CHANNEL) {
    await postIssueAnswerback(slack, issueKey, {
      channel: process.env.SLACK_LEGAL_CHANNEL,
      text: `✅ 押印完了: ${issueKey}\n${input.documentUrl}`,
    });
  }
}

export async function rejectStamp(
  slack: SlackMessageClient,
  issueKey: string,
  rejectedReason: string,
  completedBySlackId?: string
) {
  await markStampRejected(issueKey, rejectedReason, completedBySlackId);

  const statusId =
    (await backlog.findStatusIdByName(WORKFLOW_STATUS.cloudSignPreparing)) ??
    (await backlog.findStatusIdByName(WORKFLOW_STATUS.counterpartyPending)) ??
    (await backlog.findStatusIdByName(WORKFLOW_STATUS.approvalPending));
  if (statusId) {
    await backlog.updateStatus(issueKey, statusId);
  }

  if (process.env.SLACK_LEGAL_CHANNEL) {
    await postIssueAnswerback(slack, issueKey, {
      channel: process.env.SLACK_LEGAL_CHANNEL,
      text: `⚠️ 押印差戻し: ${issueKey}\n${rejectedReason}`,
    });
  }
}

function buildApprovalBlocks(
  issue: BacklogIssue,
  primaryDocumentUrl?: string,
  assignment?: { department?: string; requesterSlackId?: string; source?: string }
): any[] {
  const blocks: any[] = [
    { type: "header", text: { type: "plain_text", text: "📄 文書承認リクエスト" } },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*課題*\n${issue.issueKey}` },
        { type: "mrkdwn", text: `*文書種別*\n${issue.issueType?.name ?? "未設定"}` },
        { type: "mrkdwn", text: `*件名*\n${issue.summary}` },
      ],
    },
  ];

  if (assignment?.department || assignment?.requesterSlackId) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `申請者: ${assignment.requesterSlackId ? `<@${assignment.requesterSlackId}>` : "不明"} / 部署: ${assignment.department ?? "未設定"} / ルール: ${assignment.source ?? "不明"}`,
        },
      ],
    });
  }

  if (primaryDocumentUrl) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*生成文書*\n${primaryDocumentUrl}` },
    });
  }

  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "✅ 承認する" },
        style: "primary",
        action_id: "approve_document",
        value: issue.issueKey,
      },
      {
        type: "button",
        text: { type: "plain_text", text: "❌ 否認する" },
        style: "danger",
        action_id: "reject_document",
        value: issue.issueKey,
      },
    ],
  });

  return blocks;
}

function buildStampBlocks(
  issue: BacklogIssue,
  primaryDocumentUrl?: string,
  assignment?: { department?: string; requesterSlackId?: string; source?: string }
): any[] {
  const blocks: any[] = [
    { type: "header", text: { type: "plain_text", text: "🔏 押印リクエスト" } },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*課題*\n${issue.issueKey}` },
        { type: "mrkdwn", text: `*文書種別*\n${issue.issueType?.name ?? "未設定"}` },
      ],
    },
  ];

  if (assignment?.department || assignment?.requesterSlackId) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `申請者: ${assignment.requesterSlackId ? `<@${assignment.requesterSlackId}>` : "不明"} / 部署: ${assignment.department ?? "未設定"} / ルール: ${assignment.source ?? "不明"}`,
        },
      ],
    });
  }

  if (primaryDocumentUrl) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*押印対象PDF*\n${primaryDocumentUrl}` },
    });
  }

  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "🖊 物理押印" },
        action_id: "stamp_physical",
        value: issue.issueKey,
      },
      {
        type: "button",
        text: { type: "plain_text", text: "✍ 電子署名" },
        action_id: "stamp_electronic",
        value: issue.issueKey,
      },
      {
        type: "button",
        text: { type: "plain_text", text: "✅ 押印完了" },
        style: "primary",
        action_id: "stamp_complete",
        value: issue.issueKey,
      },
      {
        type: "button",
        text: { type: "plain_text", text: "⚠️ 差戻し" },
        style: "danger",
        action_id: "stamp_reject",
        value: issue.issueKey,
      },
    ],
  });

  return blocks;
}
