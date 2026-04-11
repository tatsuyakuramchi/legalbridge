import { createOptionalSlackClient, SlackMessageClient } from "../slack/optionalClient";
import { generateDocumentsForIssue } from "../webhook/backlog";
import {
  beginWorkExecution,
  completeWorkExecution,
  failWorkExecution,
} from "../db/repository";
import { getWorkExecutionKey, WorkItem } from "./workItems";

export type ExecuteWorkItemResult =
  | { status: "executed"; executionKey: string }
  | { status: "skipped"; reason: "duplicate_succeeded" | "duplicate_running"; executionKey: string };

export async function executeWorkItem(
  item: WorkItem,
  input?: { slack?: SlackMessageClient },
): Promise<ExecuteWorkItemResult> {
  const slack = input?.slack ?? createOptionalSlackClient(process.env.SLACK_BOT_TOKEN);
  const executionKey = getWorkExecutionKey(item);
  const begun = await beginWorkExecution({
    executionKey,
    workType: item.type,
    issueKey: item.issueKey,
    source: item.source,
  });

  if (begun.state === "duplicate_succeeded" || begun.state === "duplicate_running") {
    console.log(`[WorkExecution] Skip ${item.type} issue=${item.issueKey} reason=${begun.state}`);
    return {
      status: "skipped",
      reason: begun.state,
      executionKey,
    };
  }

  try {
    await generateDocumentsForIssue(item.issueKey, item.issueTypeName, item.content, slack);
    await completeWorkExecution(executionKey);
    return {
      status: "executed",
      executionKey,
    };
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    await failWorkExecution(executionKey, message);
    throw error;
  }
}
