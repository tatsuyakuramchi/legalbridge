export type WorkSource = "backlog-webhook" | "backlog-poller" | "admin-api";

export type WorkIssueContent = {
  keyId?: number;
  summary?: string;
  status?: { id: number; name: string };
  issueType?: { id: number; name: string };
  customFields?: Array<{ fieldId: number; value: string | null }>;
  comment?: { id?: number; content?: string | null };
  created?: string;
  updated?: string;
};

export type GenerateDocumentsWorkItem = {
  type: "generate-documents";
  source: WorkSource;
  issueKey: string;
  issueTypeName: string;
  content: WorkIssueContent;
};

export type WorkItem = GenerateDocumentsWorkItem;

export function createGenerateDocumentsWorkItem(input: {
  source: WorkSource;
  issueKey: string;
  issueTypeName: string;
  content: WorkIssueContent;
}): GenerateDocumentsWorkItem {
  return {
    type: "generate-documents",
    source: input.source,
    issueKey: input.issueKey,
    issueTypeName: input.issueTypeName,
    content: input.content,
  };
}

export function summarizeWorkItem(item: WorkItem): string {
  return `${item.type} issue=${item.issueKey} issueType=${item.issueTypeName} source=${item.source}`;
}

export function getWorkExecutionKey(item: WorkItem): string {
  const updatedAt = item.content.updated ?? "na";
  const statusId = item.content.status?.id ?? "na";
  return [
    item.type,
    item.issueKey,
    item.issueTypeName,
    item.source,
    statusId,
    updatedAt,
  ].join(":");
}
