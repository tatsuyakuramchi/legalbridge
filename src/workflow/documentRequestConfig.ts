export type DocumentRequestType =
  | "legal_consultation"
  | "nda"
  | "outsourcing"
  | "license"
  | "license_schedule"
  | "ip_overseas_master"
  | "ip_overseas_amendment"
  | "sales_buyer"
  | "sales_seller_standard"
  | "sales_seller_credit"
  | "delivery_request"
  | "royalty_calculation_manufacturing"
  | "royalty_calculation_sales_report"
  | "purchase_order"
  | "planning_order"
  | "publishing_order";

export interface DocumentRequestDefinition {
  value: DocumentRequestType;
  text: string;
  backlogIssueTypeName: string;
  autoGenerate: boolean;
  dataOwner: "backlog" | "db";
  family: "consultation" | "contract" | "license" | "sales" | "order" | "delivery" | "royalty";
  workflowKind: "primary" | "followup";
  followUpShortcut?: "delivery_request" | "royalty_calculation";
}

export const DOCUMENT_REQUEST_DEFINITIONS: DocumentRequestDefinition[] = [
  {
    value: "legal_consultation",
    text: "法務相談",
    backlogIssueTypeName: process.env.BACKLOG_ISSUE_TYPE_LEGAL_CONSULTATION ?? "法務相談",
    autoGenerate: false,
    dataOwner: "backlog",
    family: "consultation",
    workflowKind: "primary",
  },
  {
    value: "nda",
    text: "秘密保持契約（NDA）",
    backlogIssueTypeName: process.env.BACKLOG_ISSUE_TYPE_NDA ?? "NDA",
    autoGenerate: false,
    dataOwner: "backlog",
    family: "contract",
    workflowKind: "primary",
  },
  {
    value: "outsourcing",
    text: "業務委託基本契約",
    backlogIssueTypeName: process.env.BACKLOG_ISSUE_TYPE_OUTSOURCING ?? "業務委託基本契約",
    autoGenerate: false,
    dataOwner: "backlog",
    family: "contract",
    workflowKind: "primary",
  },
  {
    value: "license",
    text: "ライセンス契約",
    backlogIssueTypeName: process.env.BACKLOG_ISSUE_TYPE_LICENSE ?? "ライセンス契約",
    autoGenerate: false,
    dataOwner: "backlog",
    family: "license",
    workflowKind: "primary",
    followUpShortcut: "royalty_calculation",
  },
  {
    value: "license_schedule",
    text: "個別利用許諾条件",
    backlogIssueTypeName: process.env.BACKLOG_ISSUE_TYPE_LICENSE_SCHEDULE ?? "個別利用許諾条件",
    autoGenerate: false,
    dataOwner: "backlog",
    family: "license",
    workflowKind: "primary",
    followUpShortcut: "royalty_calculation",
  },
  {
    value: "ip_overseas_master",
    text: "海外IP契約（基本契約）",
    backlogIssueTypeName: process.env.BACKLOG_ISSUE_TYPE_IP_OVERSEAS_MASTER ?? "海外IP契約（基本契約）",
    autoGenerate: false,
    dataOwner: "backlog",
    family: "license",
    workflowKind: "primary",
  },
  {
    value: "ip_overseas_amendment",
    text: "海外IP契約（変更合意）",
    backlogIssueTypeName: process.env.BACKLOG_ISSUE_TYPE_IP_OVERSEAS_AMENDMENT ?? "海外IP契約（変更合意）",
    autoGenerate: false,
    dataOwner: "backlog",
    family: "license",
    workflowKind: "primary",
  },
  {
    value: "sales_buyer",
    text: "売買契約（当社買手）",
    backlogIssueTypeName: process.env.BACKLOG_ISSUE_TYPE_SALES_BUYER ?? "売買契約（当社買手）",
    autoGenerate: false,
    dataOwner: "backlog",
    family: "sales",
    workflowKind: "primary",
  },
  {
    value: "sales_seller_standard",
    text: "売買契約（当社売手・標準）",
    backlogIssueTypeName: process.env.BACKLOG_ISSUE_TYPE_SALES_SELLER_STANDARD ?? "売買契約（当社売手・標準）",
    autoGenerate: false,
    dataOwner: "backlog",
    family: "sales",
    workflowKind: "primary",
  },
  {
    value: "sales_seller_credit",
    text: "売買契約（当社売手・保証金掛け売り）",
    backlogIssueTypeName: process.env.BACKLOG_ISSUE_TYPE_SALES_SELLER_CREDIT ?? "売買契約（当社売手・保証金掛け売り）",
    autoGenerate: false,
    dataOwner: "backlog",
    family: "sales",
    workflowKind: "primary",
  },
  {
    value: "delivery_request",
    text: "納品リクエスト",
    backlogIssueTypeName: process.env.BACKLOG_ISSUE_TYPE_DELIVERY ?? "納品リクエスト",
    autoGenerate: false,
    dataOwner: "db",
    family: "delivery",
    workflowKind: "followup",
  },
  {
    value: "royalty_calculation_manufacturing",
    text: "利用許諾料計算（製造ベース）",
    backlogIssueTypeName: process.env.BACKLOG_ISSUE_TYPE_MFG ?? "製造案件",
    autoGenerate: false,
    dataOwner: "db",
    family: "royalty",
    workflowKind: "followup",
  },
  {
    value: "royalty_calculation_sales_report",
    text: "利用許諾料計算（売上報告ベース）",
    backlogIssueTypeName: process.env.BACKLOG_ISSUE_TYPE_ROYALTY_SALES ?? "売上報告案件",
    autoGenerate: false,
    dataOwner: "db",
    family: "royalty",
    workflowKind: "followup",
  },
  {
    value: "purchase_order",
    text: "発注書",
    backlogIssueTypeName: process.env.BACKLOG_ISSUE_TYPE_PURCHASE_ORDER ?? "発注書",
    autoGenerate: false,
    dataOwner: "db",
    family: "order",
    workflowKind: "primary",
    followUpShortcut: "delivery_request",
  },
  {
    value: "planning_order",
    text: "企画発注書",
    backlogIssueTypeName: process.env.BACKLOG_ISSUE_TYPE_PLANNING_ORDER ?? "企画発注書",
    autoGenerate: false,
    dataOwner: "db",
    family: "order",
    workflowKind: "primary",
    followUpShortcut: "delivery_request",
  },
  {
    value: "publishing_order",
    text: "出版発注書",
    backlogIssueTypeName: process.env.BACKLOG_ISSUE_TYPE_PUBLISHING_ORDER ?? "出版発注書",
    autoGenerate: false,
    dataOwner: "db",
    family: "order",
    workflowKind: "primary",
    followUpShortcut: "delivery_request",
  },
];

export function getDocumentRequestDefinition(value: string): DocumentRequestDefinition | undefined {
  return DOCUMENT_REQUEST_DEFINITIONS.find((item) => item.value === value);
}

export function getPrimaryDocumentRequestDefinitions(): DocumentRequestDefinition[] {
  return DOCUMENT_REQUEST_DEFINITIONS.filter((item) => item.workflowKind === "primary");
}
