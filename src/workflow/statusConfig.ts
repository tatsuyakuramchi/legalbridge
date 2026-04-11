export const WORKFLOW_STATUS = {
  documentRequested: process.env.BACKLOG_STATUS_DOCUMENT_REQUESTED ?? "文書生成依頼",
  draft: process.env.BACKLOG_STATUS_DRAFT ?? "草案",
  review: process.env.BACKLOG_STATUS_REVIEW ?? process.env.BACKLOG_STATUS_DRAFT ?? "草案",
  approvalPending: process.env.BACKLOG_STATUS_APPROVAL_PENDING ?? "承認待ち",
  counterpartyPending: process.env.BACKLOG_STATUS_COUNTERPARTY_PENDING ?? "相手方確認待ち",
  cloudSignPreparing: process.env.BACKLOG_STATUS_CLOUDSIGN_PREPARING ?? "クラウドサイン送信準備",
  stampPending: process.env.BACKLOG_STATUS_STAMP_PENDING ?? "押印依頼中",
  signed: process.env.BACKLOG_STATUS_SIGNED ?? "締結済",
  completed: process.env.BACKLOG_STATUS_COMPLETED ?? "完了",
  discarded: process.env.BACKLOG_STATUS_DISCARDED ?? "破棄",
} as const;

export function isDocumentWorkflowIssue(issueTypeName: string): boolean {
  return ![
    process.env.BACKLOG_ISSUE_TYPE_MFG ?? "製造案件",
    process.env.BACKLOG_ISSUE_TYPE_LEGAL_CONSULTATION ?? "法務相談",
    "法律相談",
    "タスク",
    "バグ",
    "要望",
    "その他",
  ].includes(issueTypeName);
}
