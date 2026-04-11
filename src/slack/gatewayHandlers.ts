import { App } from "@slack/bolt";
import { backlog } from "../backlog/client";
import { downloadSlackFile } from "../documents/fileStorage";
import { getDocumentRequestDefinition } from "../workflow/documentRequestConfig";
import {
  buildLegalRequestAppendModal,
  buildLegalRequestEntryModal,
  buildSimpleLegalRequestModal,
} from "./modalBuilders";

export function registerSlackGatewayHandlers(app: App): void {
  app.command("/法務依頼", async ({ command, ack, client, respond, logger }) => {
    await ack();

    try {
      const issueKey = normalizeIssueKeyInput(command.text);
      await client.views.open({
        trigger_id: command.trigger_id,
        view: issueKey
          ? buildLegalRequestAppendModal(command.channel_id, command.user_id, { existing_issue_key: issueKey })
          : buildLegalRequestEntryModal(command.channel_id, command.user_id),
      });
    } catch (error) {
      logger.error("[Gateway] 法務依頼モーダル表示失敗", error);
      await respond({
        response_type: "ephemeral",
        text: "⚠️ 法務依頼フォームを開けませんでした。",
      });
    }
  });

  app.view("legal_request_entry_modal", async ({ ack, view }) => {
    const values = view.state.values;
    const mode = values.request_mode?.request_mode_select?.selected_option?.value ?? "new_request";
    const issueKey = (values.existing_issue_key?.input?.value ?? "").trim().toUpperCase();
    const metadata = JSON.parse(view.private_metadata || "{}");

    await ack({
      response_action: "update",
      view: mode === "append_request"
        ? buildLegalRequestAppendModal(metadata.channelId ?? "", metadata.userId ?? "", { existing_issue_key: issueKey })
        : buildSimpleLegalRequestModal(metadata.channelId ?? "", metadata.userId ?? "", {}),
    });
  });

  app.view("legal_request_simple_modal", async ({ ack, view, body, client, logger }) => {
    const values = view.state.values;
    const userId = body.user.id;
    const requestedContractType = values.contract_type?.simple_contract_type_select?.selected_option?.value ?? "legal_consultation";
    const contractType = requestedContractType === "legal_review" ? "legal_consultation" : requestedContractType;
    const summary = (values.summary?.input?.value ?? "").trim();
    const notes = (values.notes?.input?.value ?? "").trim();
    const deadline = values.deadline?.datepicker?.selected_date ?? "";
    const counterparty = (values.counterparty?.input?.value ?? "").trim();
    const slackAttachmentFileIds = extractSlackAttachmentFileIds(values);

    const validationErrors: Record<string, string> = {};
    if (!summary) validationErrors.summary = "件名を入力してください。";
    if (!notes) validationErrors.notes = "依頼内容を入力してください。";
    if (Object.keys(validationErrors).length > 0) {
      await ack({ response_action: "errors", errors: validationErrors });
      return;
    }

    await ack();

    try {
      const requestDefinition = getDocumentRequestDefinition(contractType);
      const issueTypeId = requestDefinition
        ? await backlog.findIssueTypeIdByName(requestDefinition.backlogIssueTypeName)
        : undefined;
      if (requestDefinition && !issueTypeId) {
        throw new Error(`Backlog課題タイプが見つかりません: ${requestDefinition.backlogIssueTypeName}`);
      }

      const attachmentIds = await uploadSlackModalFilesToBacklog({
        client,
        logger,
        slackFileIds: slackAttachmentFileIds,
        issueSummary: summary,
      });

      const issue = await backlog.createIssue({
        summary: buildLegalRequestIssueSummary(summary, counterparty),
        description: buildSimpleBacklogDescription({
          userId,
          contractTypeLabel: requestedContractType === "legal_review" ? "レビュー依頼" : requestDefinition?.text ?? contractType,
          summary,
          notes,
          deadline,
          counterparty,
        }),
        issueTypeId,
        dueDate: deadline || undefined,
        attachmentIds,
        customFields: buildSimpleBacklogCustomFields({
          requester: process.env.BACKLOG_FIELD_REQUESTER ? `<@${userId}>` : "",
          contractTypeLabel: requestedContractType === "legal_review" ? "レビュー依頼" : requestDefinition?.text ?? contractType,
          counterparty,
          deadline,
          remarks: notes,
        }),
      });

      await notifyRequesterSuccess({
        client,
        logger,
        userId,
        issueKey: issue.issueKey,
        summary: issue.summary,
      });
    } catch (error) {
      logger.error("[Gateway] 新規依頼起票失敗", error);
      await notifyRequesterFailure({ client, logger, userId });
    }
  });

  app.view("legal_request_append_modal", async ({ ack, view, body, client, logger }) => {
    const values = view.state.values;
    const userId = body.user.id;
    const issueKey = normalizeIssueKeyInput(values.existing_issue_key?.input?.value ?? "");
    const appendNotes = (values.append_notes?.input?.value ?? "").trim();
    const slackAttachmentFileIds = extractSlackAttachmentFileIds(values);

    const validationErrors: Record<string, string> = {};
    if (!issueKey) {
      validationErrors.existing_issue_key = "課題キーを入力してください。";
    }
    if (!appendNotes && slackAttachmentFileIds.length === 0) {
      validationErrors.append_notes = "追記内容または添付ファイルのどちらかを入れてください。";
    }
    if (Object.keys(validationErrors).length > 0) {
      await ack({ response_action: "errors", errors: validationErrors });
      return;
    }

    await ack();

    try {
      const issue = await backlog.getIssue(issueKey!);
      const attachmentIds = await uploadSlackModalFilesToBacklog({
        client,
        logger,
        slackFileIds: slackAttachmentFileIds,
        issueSummary: issue.summary,
      });

      await backlog.addCommentWithAttachments(
        issue.issueKey,
        buildAppendComment({ userId, notes: appendNotes, attachmentCount: attachmentIds.length }),
        attachmentIds,
      );

      await notifyRequesterAppendSuccess({
        client,
        logger,
        userId,
        issueKey: issue.issueKey,
      });
    } catch (error) {
      logger.error("[Gateway] 課題追記失敗", error);
      await notifyRequesterFailure({ client, logger, userId });
    }
  });
}

function normalizeIssueKeyInput(value: string): string | undefined {
  const normalized = value.trim().toUpperCase();
  return /^[A-Z][A-Z0-9_]*-\d+$/.test(normalized) ? normalized : undefined;
}

function buildLegalRequestIssueSummary(summary: string, counterparty: string): string {
  const cleanCounterparty = counterparty.trim();
  return cleanCounterparty ? `【法務依頼】${summary}（${cleanCounterparty}）` : `【法務依頼】${summary}`;
}

function buildSimpleBacklogDescription(input: {
  userId: string;
  contractTypeLabel: string;
  summary: string;
  notes: string;
  deadline: string;
  counterparty: string;
}): string {
  return [
    "【Slack法務依頼】",
    "",
    `依頼者: <@${input.userId}>`,
    `依頼種別: ${input.contractTypeLabel}`,
    `件名: ${input.summary}`,
    `相手先: ${input.counterparty || "未入力"}`,
    `希望納期: ${input.deadline || "指定なし"}`,
    "",
    "依頼内容:",
    input.notes,
    "",
    "添付ファイルがある場合は課題添付を確認してください。",
  ].join("\n");
}

function buildSimpleBacklogCustomFields(values: {
  requester: string;
  contractTypeLabel: string;
  counterparty: string;
  deadline: string;
  remarks: string;
}): Record<string, string> {
  return sanitizeCustomFieldEntries({
    [process.env.BACKLOG_FIELD_REQUESTER ?? ""]: values.requester,
    [process.env.BACKLOG_FIELD_CONTRACT_TYPE ?? ""]: values.contractTypeLabel,
    [process.env.BACKLOG_FIELD_COUNTERPARTY ?? ""]: values.counterparty,
    [process.env.BACKLOG_FIELD_DEADLINE ?? ""]: values.deadline,
    [process.env.BACKLOG_FIELD_REMARKS ?? ""]: values.remarks,
  });
}

function buildAppendComment(input: { userId: string; notes: string; attachmentCount: number }): string {
  return [
    "[Slack追記]",
    `追記者: <@${input.userId}>`,
    input.notes ? "" : "内容: 添付ファイルを追加しました。",
    input.notes ? `内容:\n${input.notes}` : "",
    input.attachmentCount > 0 ? `添付: ${input.attachmentCount}件` : "",
  ].filter(Boolean).join("\n");
}

function sanitizeCustomFieldEntries(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).filter(([fieldId, value]) => fieldId && String(value ?? "").trim() !== ""),
  );
}

function extractSlackAttachmentFileIds(values: Record<string, any>): string[] {
  const attachmentValue = values.request_attachments?.file_input;
  if (!attachmentValue) {
    return [];
  }

  const rawValues = [
    ...(Array.isArray(attachmentValue.selected_files) ? attachmentValue.selected_files : []),
    ...(Array.isArray(attachmentValue.files) ? attachmentValue.files : []),
    ...(Array.isArray(attachmentValue.file_ids) ? attachmentValue.file_ids : []),
    ...(attachmentValue.selected_file ? [attachmentValue.selected_file] : []),
  ];

  return rawValues
    .map((item: any) => {
      if (typeof item === "string") return item;
      if (typeof item?.id === "string") return item.id;
      return "";
    })
    .filter(Boolean);
}

async function uploadSlackModalFilesToBacklog(params: {
  client: any;
  logger: any;
  slackFileIds: string[];
  issueSummary: string;
}): Promise<number[]> {
  if (params.slackFileIds.length === 0 || !process.env.SLACK_BOT_TOKEN) {
    return [];
  }

  const attachmentIds: number[] = [];
  for (const [index, fileId] of params.slackFileIds.entries()) {
    try {
      const fileInfo = await params.client.files.info({ file: fileId });
      const slackFile = fileInfo.file as any;
      const downloadUrl = slackFile?.url_private_download ?? slackFile?.url_private;
      if (!downloadUrl) {
        continue;
      }

      const stored = await downloadSlackFile({
        url: downloadUrl,
        token: process.env.SLACK_BOT_TOKEN,
        outputBasename: `${sanitizeAttachmentBasename(params.issueSummary)}_${index + 1}`,
        uploadToDrive: false,
      });

      const attachmentId = await backlog.uploadAttachment(
        stored.localPath,
        sanitizeBacklogAttachmentName(slackFile?.name, fileId),
      );
      attachmentIds.push(attachmentId);
    } catch (error) {
      params.logger.warn("[Gateway] 添付ファイルのBacklog転送に失敗しました。", { fileId, error });
    }
  }

  return attachmentIds;
}

async function notifyRequesterSuccess(params: {
  client: any;
  logger: any;
  userId: string;
  issueKey: string;
  summary: string;
}): Promise<void> {
  await notifyViaDm(params.client, params.logger, params.userId, [
    `Backlog に法務依頼を起票しました: \`${params.issueKey}\``,
    `件名: ${params.summary}`,
    `進捗確認: \`/法務ステータス ${params.issueKey}\``,
  ].join("\n"));
}

async function notifyRequesterAppendSuccess(params: {
  client: any;
  logger: any;
  userId: string;
  issueKey: string;
}): Promise<void> {
  await notifyViaDm(params.client, params.logger, params.userId, [
    `Backlog 課題へ追記しました: \`${params.issueKey}\``,
    `進捗確認: \`/法務ステータス ${params.issueKey}\``,
  ].join("\n"));
}

async function notifyRequesterFailure(params: {
  client: any;
  logger: any;
  userId: string;
}): Promise<void> {
  await notifyViaDm(
    params.client,
    params.logger,
    params.userId,
    "⚠️ Backlog への反映に失敗しました。時間を空けて再度お試しください。",
  );
}

async function notifyViaDm(client: any, logger: any, userId: string, text: string): Promise<void> {
  try {
    const dm = await client.conversations.open({ users: userId });
    if (!dm.channel?.id) {
      throw new Error("DM channel が取得できませんでした。");
    }
    await client.chat.postMessage({
      channel: dm.channel.id,
      text,
    });
  } catch (error) {
    logger.warn("[Gateway] DM通知を送信できませんでした。", error);
  }
}

function sanitizeAttachmentBasename(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return `legal_request_${Date.now()}`;
  }
  return trimmed.replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(0, 60) || `legal_request_${Date.now()}`;
}

function sanitizeBacklogAttachmentName(value: string | undefined, fallbackId: string): string {
  const base = (value ?? fallbackId).trim();
  return (base.replace(/[/\\:*?"<>|]/g, "_") || `${fallbackId}.bin`).slice(0, 120);
}
