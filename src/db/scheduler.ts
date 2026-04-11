/**
 * db/scheduler.ts
 * 定期実行タスク
 *
 * - 毎朝9時: 支払期限が近い案件をSlackに通知
 * - 毎朝9時: 期限超過した未払いを OVERDUE に更新
 * - 毎朝9時: 発注明細の納期アラートをSlackスレッドとDMに通知
 *
 * ローカルでは Node.js の setInterval で動作。
 * 本番（EC2）では cron または AWS EventBridge に切り替え可。
 */

import {
  createOrderDueReminderLog,
  findOrderDueReminderLog,
  getUpcomingPayments,
  getUpcomingOrderDueReminderTargets,
  listIssueWorkflowsByIssueKeys,
  listApprovalReminderTargets,
  listStampReminderTargets,
  markOverduePayments,
} from "./repository";
import { postIssueAnswerback } from "../slack/threading";
import { SlackMessageClient } from "../slack/optionalClient";

type SchedulerRunSummary = {
  overdueCount: number;
  upcomingPaymentsNotified: number;
  orderDueRemindersSent: number;
  approvalRemindersSent: number;
  stampRemindersSent: number;
};

type SchedulerHooks = {
  onStarted?: (input: { intervalHours: number }) => void;
  onRunSuccess?: (summary: SchedulerRunSummary) => void;
  onRunError?: (error: unknown) => void;
};

export type { SchedulerRunSummary, SchedulerHooks };

/** アプリ起動時に呼び出す */
export function startScheduler(slack: SlackMessageClient, hooks?: SchedulerHooks): void {
  // 起動直後に1回実行（動作確認）
  hooks?.onStarted?.({ intervalHours: 24 });
  runSchedulerOnce(slack)
    .then((summary) => hooks?.onRunSuccess?.(summary))
    .catch((error) => {
      hooks?.onRunError?.(error);
      console.error(error);
    });

  // 以降は24時間ごとに実行
  setInterval(() => {
    runSchedulerOnce(slack)
      .then((summary) => hooks?.onRunSuccess?.(summary))
      .catch((error) => {
        hooks?.onRunError?.(error);
        console.error(error);
      });
  }, 24 * 60 * 60 * 1000);

  console.log("[Scheduler] 定期タスク開始（24時間ごと）");
}

export async function runSchedulerOnce(slack: SlackMessageClient): Promise<SchedulerRunSummary> {
  console.log("[Scheduler] 定期タスク実行:", new Date().toLocaleString("ja-JP"));

  // 1. 期限超過の更新
  const overdueCount = await markOverduePayments();
  if (overdueCount > 0) {
    console.log(`[Scheduler] OVERDUE更新: ${overdueCount}件`);
  }

  // 2. 14日以内の支払期限通知
  const upcomingPaymentsNotified = await notifyUpcomingPayments(slack);

  // 3. 発注明細の納期通知
  const orderDueRemindersSent = await notifyOrderDueReminders(slack);

  // 4. 承認待ちリマインダー
  const approvalRemindersSent = await notifyApprovalReminders(slack);

  // 5. 押印待ちリマインダー
  const stampRemindersSent = await notifyStampReminders(slack);

  return {
    overdueCount,
    upcomingPaymentsNotified,
    orderDueRemindersSent,
    approvalRemindersSent,
    stampRemindersSent,
  };
}

async function notifyUpcomingPayments(slack: SlackMessageClient): Promise<number> {
  const payments = await getUpcomingPayments(14);
  if (payments.length === 0) return 0;

  const channel = String(process.env.SLACK_LEGAL_CHANNEL ?? "").trim();
  if (!channel) {
    console.warn("[Scheduler] SLACK_LEGAL_CHANNEL 未設定のため支払期限通知をスキップしました。");
    return 0;
  }
  const today = new Date();

  const blocks: object[] = [
    {
      type: "header",
      text: { type: "plain_text", text: "⏰ ロイヤリティ支払期限アラート" },
    },
  ];

  for (const p of payments) {
    const daysLeft = Math.ceil(
      (p.paymentDueDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)
    );
    const isOverdue = p.status === "OVERDUE";
    const emoji = isOverdue ? "🔴" : daysLeft <= 3 ? "🟡" : "🔵";
    const dueDateStr = p.paymentDueDate.toLocaleDateString("ja-JP");
    const amountStr = p.totalAmount.toLocaleString("ja-JP");

    blocks.push({
      type: "section",
      fields: [
        {
          type: "mrkdwn",
          text: `${emoji} *${p.licenseContract.licensor}*\n${p.manufacturingEvent.productName}（${p.manufacturingEvent.edition}）`,
        },
        {
          type: "mrkdwn",
          text: isOverdue
            ? `*⚠️ 支払期限超過*\n期日: ${dueDateStr}\n金額: ¥${amountStr}`
            : `*支払期日: ${dueDateStr}*（残${daysLeft}日）\n金額: ¥${amountStr}`,
        },
      ],
    });

    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Backlog: <https://${process.env.BACKLOG_SPACE}.backlog.com/view/${p.manufacturingEvent.backlogIssueKey}|${p.manufacturingEvent.backlogIssueKey}> ｜ ライセンス: ${p.licenseContract.backlogIssueKey}`,
        },
      ],
    });

    blocks.push({ type: "divider" });
  }

  await slack.chat.postMessage({
    channel,
    text: `⏰ 支払期限アラート（${payments.length}件）`,
    blocks: blocks as any,
  });

  console.log(`[Scheduler] アラート送信: ${payments.length}件`);
  return payments.length;
}

async function notifyOrderDueReminders(slack: SlackMessageClient): Promise<number> {
  const items = await getUpcomingOrderDueReminderTargets(7);
  if (items.length === 0) return 0;

  const workflowMap = new Map(
    (await listIssueWorkflowsByIssueKeys(Array.from(new Set(items.map((item) => item.legalRequest.backlogIssueKey)))))
      .map((workflow) => [workflow.backlogIssueKey, workflow.currentStatusName ?? ""])
  );

  const today = startOfDay(new Date());
  let sentCount = 0;

  for (const item of items) {
    const currentStatusName = workflowMap.get(item.legalRequest.backlogIssueKey) ?? "";
    if (!shouldSendOrderDueReminder(currentStatusName)) {
      continue;
    }

    const dueDate = startOfDay(item.latestDueDate);
    const daysUntilDue = Math.round((dueDate.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
    const reminderType = resolveOrderDueReminderType(daysUntilDue);
    if (!reminderType) {
      continue;
    }

    const alreadySent = await findOrderDueReminderLog(item.id, reminderType, today);
    if (alreadySent) {
      continue;
    }

    const payload = buildOrderDueReminderPayload(item, currentStatusName, daysUntilDue);

    await postIssueAnswerback(slack, item.legalRequest.backlogIssueKey, {
      text: payload.text,
      blocks: payload.threadBlocks as any,
    });

    await createOrderDueReminderLog(item.id, reminderType, today);
    sentCount += 1;
  }

  if (sentCount > 0) {
    console.log(`[Scheduler] 納期アラート送信: ${sentCount}件`);
  }
  return sentCount;
}

async function notifyApprovalReminders(slack: SlackMessageClient): Promise<number> {
  const reminders = await listApprovalReminderTargets(24);
  let sentCount = 0;
  for (const workflow of reminders) {
    if (!workflow.approverSlackId) continue;
    await slack.chat.postMessage({
      channel: workflow.approverSlackId,
      text: `⏰ 承認待ちリマインダー: ${workflow.backlogIssueKey} は24時間以上未承認です。`,
    });
    sentCount += 1;
  }
  return sentCount;
}

function buildOrderDueReminderPayload(
  item: Awaited<ReturnType<typeof getUpcomingOrderDueReminderTargets>>[number],
  currentStatusName: string,
  daysUntilDue: number
) {
  const dueDateLabel = item.latestDueDate.toLocaleDateString("ja-JP");
  const issueKey = item.legalRequest.backlogIssueKey;
  const stageLabel = describeOrderDueReminder(daysUntilDue);
  const statusLabel = currentStatusName || "未同期";
  const text = `⏰ 納期アラート: ${issueKey} / 明細${item.itemNo} / ${stageLabel}`;

  return {
    text,
    threadBlocks: [
      { type: "header", text: { type: "plain_text", text: "⏰ 発注明細の納期アラート" } },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*課題*\n${issueKey}` },
          { type: "mrkdwn", text: `*現在ステータス*\n${statusLabel}` },
          { type: "mrkdwn", text: `*明細*\nNo.${item.itemNo} ${item.description}` },
          { type: "mrkdwn", text: `*納期*\n${dueDateLabel} (${stageLabel})` },
        ],
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `案件: ${item.legalRequest.summary}${item.legalRequest.counterparty ? ` / 相手方: ${item.legalRequest.counterparty}` : ""}`,
          },
        ],
      },
    ],
    dmBlocks: [
      { type: "header", text: { type: "plain_text", text: "⏰ 発注明細の納期アラート" } },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `受付番号 \`${issueKey}\` の明細 No.${item.itemNo}「${item.description}」が ${stageLabel} です。`,
        },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*納期*\n${dueDateLabel}` },
          { type: "mrkdwn", text: `*現在ステータス*\n${statusLabel}` },
        ],
      },
    ],
  };
}

function resolveOrderDueReminderType(daysUntilDue: number): string | null {
  if (daysUntilDue === 7) return "DUE_7";
  if (daysUntilDue === 3) return "DUE_3";
  if (daysUntilDue === 0) return "DUE_0";
  if (daysUntilDue < 0) return "OVERDUE";
  return null;
}

function describeOrderDueReminder(daysUntilDue: number): string {
  if (daysUntilDue === 7) return "納期1週間前";
  if (daysUntilDue === 3) return "納期3日前";
  if (daysUntilDue === 0) return "納期当日";
  return `納期超過 ${Math.abs(daysUntilDue)}日目`;
}

function shouldSendOrderDueReminder(currentStatusName: string): boolean {
  if (!currentStatusName) return true;

  const excludedStatuses = new Set(
    String(process.env.BACKLOG_ORDER_DUE_ALERT_EXCLUDED_STATUSES ?? "完了,破棄,締結済")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );

  return !excludedStatuses.has(currentStatusName);
}

function startOfDay(value: Date): Date {
  const result = new Date(value);
  result.setHours(0, 0, 0, 0);
  return result;
}

async function notifyStampReminders(slack: SlackMessageClient): Promise<number> {
  const reminders = await listStampReminderTargets(48);
  let sentCount = 0;
  for (const workflow of reminders) {
    const channel = workflow.stampOperatorSlackId ?? process.env.SLACK_LEGAL_CHANNEL!;
    await slack.chat.postMessage({
      channel,
      text: `⏰ 押印待ちリマインダー: ${workflow.backlogIssueKey} は48時間以上未完了です。`,
    });
    sentCount += 1;
  }
  return sentCount;
}
