import { backlog } from "./client";
import {
  findBacklogSyncState,
  markBacklogSyncFailed,
  markBacklogSyncProcessed,
  upsertBacklogSyncState,
} from "../db/repository";
import { handlePolledIssueTransition } from "../workflow/router";
import { SlackMessageClient } from "../slack/optionalClient";

const DEFAULT_INTERVAL_SEC = 30;
let isBootstrapped = false;

type BacklogPollingSummary = {
  issueCount: number;
  changedCount: number;
  processedCount: number;
  failedCount: number;
  bootstrapped: boolean;
};

type BacklogPollingHooks = {
  onStarted?: (input: { intervalSec: number }) => void;
  onRunSuccess?: (summary: BacklogPollingSummary) => void;
  onRunError?: (error: unknown) => void;
};

export type { BacklogPollingSummary, BacklogPollingHooks };

export function startBacklogPolling(slack: SlackMessageClient, hooks?: BacklogPollingHooks): void {
  const intervalSec = Number(process.env.BACKLOG_POLLING_INTERVAL_SEC ?? DEFAULT_INTERVAL_SEC);
  hooks?.onStarted?.({ intervalSec });

  runBacklogPollingOnce(slack)
    .then((summary) => hooks?.onRunSuccess?.(summary))
    .catch((error) => {
      hooks?.onRunError?.(error);
      console.error("[BacklogPoller] 初回実行失敗", error);
    });

  setInterval(() => {
    runBacklogPollingOnce(slack)
      .then((summary) => hooks?.onRunSuccess?.(summary))
      .catch((error) => {
        hooks?.onRunError?.(error);
        console.error("[BacklogPoller] 定期実行失敗", error);
      });
  }, intervalSec * 1000);

  console.log(`[BacklogPoller] 開始 (${intervalSec}秒間隔)`);
}

export async function runBacklogPollingOnce(slack: SlackMessageClient): Promise<BacklogPollingSummary> {
  const issues = await backlog.listIssues({ count: 100 });
  let changedCount = 0;
  let processedCount = 0;
  let failedCount = 0;
  for (const issue of issues) {
    const existing = await findBacklogSyncState(issue.issueKey);
    const isChanged =
      !existing ||
      existing.statusId !== issue.status.id ||
      existing.lastBacklogUpdatedAt.getTime() !== new Date(issue.updated).getTime();

    await upsertBacklogSyncState(issue);

    if (!isBootstrapped) {
      continue;
    }

    if (!isChanged) {
      continue;
    }
    changedCount += 1;

    try {
      await handlePolledIssueTransition(issue, slack);
      await markBacklogSyncProcessed(issue.issueKey);
      processedCount += 1;
    } catch (error) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      console.error(`[BacklogPoller] 課題処理失敗: ${issue.issueKey}`, error);
      await markBacklogSyncFailed(issue.issueKey, message);
      failedCount += 1;
    }
  }

  if (!isBootstrapped) {
    isBootstrapped = true;
    console.log("[BacklogPoller] 初回スナップショットを保存しました");
  }

  return {
    issueCount: issues.length,
    changedCount,
    processedCount,
    failedCount,
    bootstrapped: isBootstrapped,
  };
}
