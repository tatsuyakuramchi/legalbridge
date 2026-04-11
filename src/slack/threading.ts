import { backlog } from "../backlog/client";
import { resolveIssueCounterparty, resolveRequesterSlackId } from "../backlog/issueContext";
import {
  findDepartmentWorkflowRule,
  findIssueWorkflow,
  findLegalRequestByBacklogKey,
  findStaffBySlackUserId,
  saveIssueSlackThread,
} from "../db/repository";
import { getWorkflowSettings } from "../workflow/workflowSettings";
import { SlackMessageClient } from "./optionalClient";

type IssueThreadMessage = {
  channel?: string;
  text: string;
  blocks?: any;
};

type IssueAnswerbackMessage = {
  text: string;
  blocks?: any;
  channel?: string;
};

export async function saveIssueRootThread(issueKey: string, channel: string, ts: string): Promise<void> {
  await saveIssueSlackThread(issueKey, channel, ts);
}

export async function ensureIssueRootThread(
  slack: SlackMessageClient,
  issueKey: string,
  preferredChannel?: string,
  options?: { reason?: "created" | "backfill" }
): Promise<{ channel: string; ts: string } | null> {
  const workflow = await findIssueWorkflow(issueKey);
  if (workflow?.requestSlackChannel && workflow.requestSlackTs) {
    return {
      channel: workflow.requestSlackChannel,
      ts: workflow.requestSlackTs,
    };
  }

  const context = await resolveIssueNotificationContext(issueKey);
  const channel = preferredChannel ?? context.channel;
  if (!channel) {
    console.warn(`[Slack] 通知先未設定のため親スレッド作成をスキップ: ${issueKey}`);
    return null;
  }

  return createIssueRootThread(slack, issueKey, channel, options?.reason ?? "backfill");
}

export async function postToIssueThread(
  slack: SlackMessageClient,
  issueKey: string,
  message: IssueThreadMessage
): Promise<any> {
  const configuredChannel = getWorkflowSettings().intakeChannelId || process.env.SLACK_LEGAL_CHANNEL;
  const fallbackChannel = message.channel ?? configuredChannel;
  if (!fallbackChannel) {
    console.warn(`[Slack] 通知先未設定のためスレッド投稿をスキップ: ${issueKey}`);
    return null;
  }

  const root = await ensureIssueRootThread(slack, issueKey, fallbackChannel, { reason: "backfill" });
  const threadChannel = root?.channel;
  const threadTs = root?.ts;

  return slack.chat.postMessage({
    ...message,
    channel: fallbackChannel,
    ...(threadChannel === fallbackChannel && threadTs ? { thread_ts: threadTs } : {}),
  } as any);
}

export async function postIssueAnswerback(
  slack: SlackMessageClient,
  issueKey: string,
  message: IssueAnswerbackMessage
): Promise<any> {
  const context = await resolveIssueNotificationContext(issueKey);
  const mentionText = buildMentionText(context.requesterSlackId, context.managerSlackId);
  const text = mentionText ? `${message.text} ${mentionText}` : message.text;
  const blocks = prependMentionBlocks(message.blocks, context.requesterSlackId, context.managerSlackId);

  return postToIssueThread(slack, issueKey, {
    channel: message.channel ?? context.channel,
    text,
    blocks,
  });
}

export async function postWorkflowAnswerback(
  slack: SlackMessageClient,
  input: {
    requesterSlackId?: string;
    managerSlackId?: string;
    channel?: string;
    text: string;
    blocks?: any;
  }
): Promise<any> {
  const configuredChannel = getWorkflowSettings().intakeChannelId || process.env.SLACK_LEGAL_CHANNEL;
  const channel = input.channel ?? configuredChannel;
  if (!channel) {
    console.warn("[Slack] 通知先未設定のためワークフロー通知をスキップしました。");
    return null;
  }

  const mentionText = buildMentionText(input.requesterSlackId, input.managerSlackId);
  const text = mentionText ? `${input.text} ${mentionText}` : input.text;
  const blocks = prependMentionBlocks(input.blocks, input.requesterSlackId, input.managerSlackId);

  return slack.chat.postMessage({
    channel,
    text,
    blocks,
  } as any);
}

async function createIssueRootThread(
  slack: SlackMessageClient,
  issueKey: string,
  channel: string,
  reason: "created" | "backfill"
): Promise<{ channel: string; ts: string } | null> {
  const [issue, legalRequest] = await Promise.all([
    backlog.getIssue(issueKey),
    findLegalRequestByBacklogKey(issueKey),
  ]);

  const requesterSlackId = resolveRequesterSlackId(issue, legalRequest);
  const requester = requesterSlackId ? `<@${requesterSlackId}>` : "不明";
  const counterparty = resolveIssueCounterparty(issue, legalRequest) || "未設定";
  const note = reason === "created"
    ? "Backlog起票を検知して親スレッドを作成しました。以後の更新はこのスレッドに集約されます。"
    : legalRequest
      ? "既存課題のため親スレッドを自動作成しました。以後の更新はこのスレッドに集約されます。"
      : "既存課題のため親スレッドを自動作成しました。";

  const root = await slack.chat.postMessage({
    channel,
    text: `📋 法務依頼: ${issue.issueKey}`,
    blocks: [
      { type: "header", text: { type: "plain_text", text: `📋 法務依頼: ${issue.issueKey}` } },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*課題番号*\n${issue.issueKey}` },
          { type: "mrkdwn", text: `*文書種別*\n${issue.issueType?.name ?? "未設定"}` },
          { type: "mrkdwn", text: `*件名*\n${issue.summary}` },
          { type: "mrkdwn", text: `*依頼者*\n${requester}` },
          { type: "mrkdwn", text: `*相手方*\n${counterparty}` },
          { type: "mrkdwn", text: `*現在ステータス*\n${issue.status.name}` },
        ],
      },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: note }],
      },
    ] as any,
  });

  if (!root.ts || root.skipped) {
    console.warn(`[Slack] 親スレッド作成をスキップしました: ${issueKey}`);
    return null;
  }

  await saveIssueRootThread(issueKey, channel, root.ts);
  return { channel, ts: root.ts };
}

async function resolveIssueNotificationContext(issueKey: string): Promise<{
  channel?: string;
  requesterSlackId?: string;
  managerSlackId?: string;
}> {
  const [workflow, legalRequest] = await Promise.all([
    findIssueWorkflow(issueKey),
    findLegalRequestByBacklogKey(issueKey),
  ]);
  const issue = await backlog.getIssue(issueKey);
  const requesterSlackId = resolveRequesterSlackId(issue, legalRequest);

  let channel = workflow?.requestSlackChannel ?? undefined;
  let managerSlackId: string | undefined;

  if (requesterSlackId) {
    const staff = await findStaffBySlackUserId(requesterSlackId);
    const department = staff?.department?.trim();
    if (department) {
      const rule = await findDepartmentWorkflowRule(department);
      channel = channel ?? rule?.postChannelId ?? undefined;
      managerSlackId = rule?.managerSlackId ?? undefined;
    }
  }

  channel =
    channel ??
    getWorkflowSettings().intakeChannelId ??
    process.env.SLACK_LEGAL_CHANNEL ??
    undefined;
  return { channel, requesterSlackId, managerSlackId };
}

function buildMentionText(requesterSlackId?: string, managerSlackId?: string): string {
  return [requesterSlackId ? `<@${requesterSlackId}>` : "", managerSlackId ? `<@${managerSlackId}>` : ""]
    .filter(Boolean)
    .join(" ");
}

function prependMentionBlocks(blocks: any, requesterSlackId?: string, managerSlackId?: string) {
  const mentionText = buildMentionText(requesterSlackId, managerSlackId);
  if (!mentionText) {
    return blocks;
  }

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: mentionText,
      },
    },
    ...(Array.isArray(blocks) ? blocks : []),
  ];
}
