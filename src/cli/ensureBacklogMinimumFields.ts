import dotenv from "dotenv";
dotenv.config();

import { backlog } from "../backlog/client";

const FIELD_TYPE = {
  text: 1,
  multiline: 2,
  numeric: 3,
  date: 4,
} as const;

type DesiredField = {
  envKey: string;
  name: string;
  description: string;
  typeId: number;
  required: boolean;
  issueTypeEnvKeys: string[];
};

const DESIRED_FIELDS: DesiredField[] = [
  {
    envKey: "BACKLOG_FIELD_CONTRACT_DATE",
    name: "contract_date",
    description: "契約日。主契約系の最小ヘッダ。",
    typeId: FIELD_TYPE.date,
    required: true,
    issueTypeEnvKeys: [
      "BACKLOG_ISSUE_TYPE_NDA",
      "BACKLOG_ISSUE_TYPE_OUTSOURCING",
      "BACKLOG_ISSUE_TYPE_LICENSE",
      "BACKLOG_ISSUE_TYPE_SALES_BUYER",
      "BACKLOG_ISSUE_TYPE_SALES_SELLER_STANDARD",
      "BACKLOG_ISSUE_TYPE_SALES_SELLER_CREDIT",
    ],
  },
  {
    envKey: "BACKLOG_FIELD_NDA_PURPOSE",
    name: "nda_purpose",
    description: "NDA の主目的。",
    typeId: FIELD_TYPE.multiline,
    required: true,
    issueTypeEnvKeys: ["BACKLOG_ISSUE_TYPE_NDA"],
  },
  {
    envKey: "BACKLOG_FIELD_CONTRACT_PERIOD",
    name: "contract_period",
    description: "契約期間。NDA の最小必須条件。",
    typeId: FIELD_TYPE.text,
    required: true,
    issueTypeEnvKeys: ["BACKLOG_ISSUE_TYPE_NDA"],
  },
  {
    envKey: "BACKLOG_FIELD_CONFIDENTIALITY_PERIOD",
    name: "confidentiality_period",
    description: "秘密保持期間。NDA 補足条件。",
    typeId: FIELD_TYPE.text,
    required: false,
    issueTypeEnvKeys: ["BACKLOG_ISSUE_TYPE_NDA"],
  },
  {
    envKey: "BACKLOG_FIELD_REMARKS",
    name: "remarks",
    description: "補足メモ、進行概要、備考。",
    typeId: FIELD_TYPE.multiline,
    required: false,
    issueTypeEnvKeys: [
      "BACKLOG_ISSUE_TYPE_OUTSOURCING",
      "BACKLOG_ISSUE_TYPE_PUBLISHING_ORDER",
    ],
  },
  {
    envKey: "BACKLOG_FIELD_ORIGINAL_WORK",
    name: "original_work",
    description: "原著作物または対象作品名。",
    typeId: FIELD_TYPE.text,
    required: true,
    issueTypeEnvKeys: [
      "BACKLOG_ISSUE_TYPE_LICENSE",
      "BACKLOG_ISSUE_TYPE_LICENSE_SCHEDULE",
    ],
  },
  {
    envKey: "BACKLOG_FIELD_JURISDICTION",
    name: "jurisdiction",
    description: "管轄裁判所。契約系の主要条件。",
    typeId: FIELD_TYPE.text,
    required: true,
    issueTypeEnvKeys: [
      "BACKLOG_ISSUE_TYPE_LICENSE",
      "BACKLOG_ISSUE_TYPE_IP_OVERSEAS_MASTER",
      "BACKLOG_ISSUE_TYPE_IP_OVERSEAS_AMENDMENT",
    ],
  },
  {
    envKey: "BACKLOG_FIELD_PRODUCT_SCOPE",
    name: "product_scope",
    description: "商品範囲。売買契約の対象。",
    typeId: FIELD_TYPE.multiline,
    required: true,
    issueTypeEnvKeys: [
      "BACKLOG_ISSUE_TYPE_SALES_BUYER",
      "BACKLOG_ISSUE_TYPE_SALES_SELLER_STANDARD",
      "BACKLOG_ISSUE_TYPE_SALES_SELLER_CREDIT",
    ],
  },
  {
    envKey: "BACKLOG_FIELD_PAYMENT_CONDITION_SUMMARY",
    name: "payment_condition_summary",
    description: "支払条件概要。Slack 最小入力で受けるヘッダ条件。",
    typeId: FIELD_TYPE.multiline,
    required: true,
    issueTypeEnvKeys: [
      "BACKLOG_ISSUE_TYPE_SALES_BUYER",
      "BACKLOG_ISSUE_TYPE_SALES_SELLER_STANDARD",
      "BACKLOG_ISSUE_TYPE_SALES_SELLER_CREDIT",
      "BACKLOG_ISSUE_TYPE_PURCHASE_ORDER",
    ],
  },
  {
    envKey: "BACKLOG_FIELD_SECURITY_DEPOSIT_AMOUNT",
    name: "security_deposit_amount",
    description: "保証金額。保証金掛け売りの主条件。",
    typeId: FIELD_TYPE.numeric,
    required: true,
    issueTypeEnvKeys: ["BACKLOG_ISSUE_TYPE_SALES_SELLER_CREDIT"],
  },
  {
    envKey: "BACKLOG_FIELD_DEPOSIT_REPLENISH_DAYS",
    name: "deposit_replenish_days",
    description: "保証金補充期限。保証金掛け売りの主条件。",
    typeId: FIELD_TYPE.text,
    required: true,
    issueTypeEnvKeys: ["BACKLOG_ISSUE_TYPE_SALES_SELLER_CREDIT"],
  },
  {
    envKey: "BACKLOG_FIELD_PROJECT_TITLE",
    name: "project_title",
    description: "案件名。発注書系の親課題ヘッダ。",
    typeId: FIELD_TYPE.text,
    required: true,
    issueTypeEnvKeys: [
      "BACKLOG_ISSUE_TYPE_PURCHASE_ORDER",
      "BACKLOG_ISSUE_TYPE_PLANNING_ORDER",
      "BACKLOG_ISSUE_TYPE_PUBLISHING_ORDER",
    ],
  },
  {
    envKey: "BACKLOG_FIELD_MASTER_CONTRACT_REF",
    name: "master_contract_ref",
    description: "マスター契約参照番号。出版発注書ヘッダ。",
    typeId: FIELD_TYPE.text,
    required: false,
    issueTypeEnvKeys: ["BACKLOG_ISSUE_TYPE_PUBLISHING_ORDER"],
  },
  {
    envKey: "BACKLOG_FIELD_LICENSE_KEY",
    name: "license_key",
    description: "親ライセンス課題キー。",
    typeId: FIELD_TYPE.text,
    required: true,
    issueTypeEnvKeys: [
      "BACKLOG_ISSUE_TYPE_LICENSE_SCHEDULE",
      "BACKLOG_ISSUE_TYPE_MFG",
      "BACKLOG_ISSUE_TYPE_ROYALTY_SALES",
    ],
  },
  {
    envKey: "BACKLOG_FIELD_LICENSE_TYPE_NAME",
    name: "license_type_name",
    description: "許諾区分。",
    typeId: FIELD_TYPE.text,
    required: true,
    issueTypeEnvKeys: ["BACKLOG_ISSUE_TYPE_LICENSE_SCHEDULE"],
  },
  {
    envKey: "BACKLOG_FIELD_LICENSE_START",
    name: "license_start",
    description: "許諾開始日。",
    typeId: FIELD_TYPE.date,
    required: true,
    issueTypeEnvKeys: ["BACKLOG_ISSUE_TYPE_LICENSE_SCHEDULE"],
  },
  {
    envKey: "BACKLOG_FIELD_TERRITORY",
    name: "territory",
    description: "許諾地域・言語。",
    typeId: FIELD_TYPE.text,
    required: false,
    issueTypeEnvKeys: ["BACKLOG_ISSUE_TYPE_LICENSE_SCHEDULE"],
  },
  {
    envKey: "BACKLOG_FIELD_PARENT_ISSUE_KEY",
    name: "parent_issue_key",
    description: "親課題キー。納品リクエストの親参照。",
    typeId: FIELD_TYPE.text,
    required: true,
    issueTypeEnvKeys: ["BACKLOG_ISSUE_TYPE_DELIVERY"],
  },
  {
    envKey: "BACKLOG_FIELD_ITEM_NO",
    name: "item_no",
    description: "明細番号。1明細1課題の識別子。",
    typeId: FIELD_TYPE.text,
    required: true,
    issueTypeEnvKeys: ["BACKLOG_ISSUE_TYPE_DELIVERY"],
  },
  {
    envKey: "BACKLOG_FIELD_DELIVERY_NOTE",
    name: "delivery_note",
    description: "納品備考。納品・検収帳票の補足。",
    typeId: FIELD_TYPE.multiline,
    required: false,
    issueTypeEnvKeys: ["BACKLOG_ISSUE_TYPE_DELIVERY"],
  },
  {
    envKey: "BACKLOG_FIELD_FINAL_DEADLINE",
    name: "final_deadline",
    description: "納期または校了予定。納品管理の正本期日。",
    typeId: FIELD_TYPE.date,
    required: true,
    issueTypeEnvKeys: ["BACKLOG_ISSUE_TYPE_DELIVERY"],
  },
  {
    envKey: "BACKLOG_FIELD_PRODUCT_NAME",
    name: "product_name",
    description: "製品名または報告単位名。",
    typeId: FIELD_TYPE.text,
    required: true,
    issueTypeEnvKeys: [
      "BACKLOG_ISSUE_TYPE_MFG",
      "BACKLOG_ISSUE_TYPE_ROYALTY_SALES",
    ],
  },
  {
    envKey: "BACKLOG_FIELD_COMPLETION_DATE",
    name: "completion_date",
    description: "製造完了日。",
    typeId: FIELD_TYPE.date,
    required: true,
    issueTypeEnvKeys: ["BACKLOG_ISSUE_TYPE_MFG"],
  },
  {
    envKey: "BACKLOG_FIELD_QUANTITY",
    name: "quantity",
    description: "製造数量。",
    typeId: FIELD_TYPE.numeric,
    required: true,
    issueTypeEnvKeys: ["BACKLOG_ISSUE_TYPE_MFG"],
  },
  {
    envKey: "BACKLOG_FIELD_MSRP",
    name: "base_price",
    description: "基準価格または MSRP。",
    typeId: FIELD_TYPE.numeric,
    required: true,
    issueTypeEnvKeys: ["BACKLOG_ISSUE_TYPE_MFG"],
  },
  {
    envKey: "BACKLOG_FIELD_REPORT_PERIOD_END",
    name: "report_period_end",
    description: "報告対象期間終了日。",
    typeId: FIELD_TYPE.date,
    required: true,
    issueTypeEnvKeys: ["BACKLOG_ISSUE_TYPE_ROYALTY_SALES"],
  },
  {
    envKey: "BACKLOG_FIELD_NET_SALES",
    name: "net_sales",
    description: "売上高または正味売上高。",
    typeId: FIELD_TYPE.numeric,
    required: true,
    issueTypeEnvKeys: ["BACKLOG_ISSUE_TYPE_ROYALTY_SALES"],
  },
  {
    envKey: "BACKLOG_FIELD_S1_REPORT_DUE",
    name: "report_due",
    description: "報告期限。",
    typeId: FIELD_TYPE.date,
    required: true,
    issueTypeEnvKeys: [
      "BACKLOG_ISSUE_TYPE_MFG",
      "BACKLOG_ISSUE_TYPE_ROYALTY_SALES",
    ],
  },
  {
    envKey: "BACKLOG_FIELD_S1_PAYMENT_DUE",
    name: "payment_due",
    description: "支払期限。",
    typeId: FIELD_TYPE.date,
    required: true,
    issueTypeEnvKeys: [
      "BACKLOG_ISSUE_TYPE_MFG",
      "BACKLOG_ISSUE_TYPE_ROYALTY_SALES",
    ],
  },
];

async function main() {
  const issueTypes = await backlog.listIssueTypes();
  const issueTypeMap = new Map(issueTypes.map((item) => [item.name, item.id]));
  const existingFields = await backlog.listCustomFields();
  const existingByName = new Map(existingFields.map((field) => [field.name, field]));

  const results: Array<Record<string, unknown>> = [];

  for (const field of DESIRED_FIELDS) {
    const configuredId = process.env[field.envKey];
    if (configuredId && /^\d+$/.test(configuredId)) {
      results.push({
        envKey: field.envKey,
        name: field.name,
        status: "configured",
        fieldId: Number(configuredId),
      });
      continue;
    }

    const existing = existingByName.get(field.name);
    if (existing) {
      results.push({
        envKey: field.envKey,
        name: field.name,
        status: "exists",
        fieldId: existing.id,
        note: "既存フィールドを再利用してください",
      });
      continue;
    }

    const applicableIssueTypeIds = field.issueTypeEnvKeys
      .map((envKey) => process.env[envKey])
      .filter((name): name is string => Boolean(name))
      .map((name) => issueTypeMap.get(name))
      .filter((id): id is number => typeof id === "number");

    const unresolvedIssueTypeEnvKeys = field.issueTypeEnvKeys.filter((envKey) => {
      const issueTypeName = process.env[envKey];
      return !issueTypeName || !issueTypeMap.has(issueTypeName);
    });

    if (unresolvedIssueTypeEnvKeys.length > 0) {
      results.push({
        envKey: field.envKey,
        name: field.name,
        status: "skipped_missing_issue_type",
        unresolvedIssueTypeEnvKeys,
      });
      continue;
    }

    const created = await backlog.addCustomField({
      name: field.name,
      typeId: field.typeId,
      description: field.description,
      required: field.required,
      applicableIssueTypeIds,
    });

    results.push({
      envKey: field.envKey,
      name: field.name,
      status: "created",
      fieldId: created.id,
      required: field.required,
      applicableIssueTypeIds,
    });
  }

  console.log(JSON.stringify({
    projectKey: process.env.BACKLOG_PROJECT_KEY ?? "",
    results,
  }, null, 2));
}

main().catch((error) => {
  console.error("[Backlog] 最小必須属性の作成に失敗");
  if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error(String(error));
  }
  process.exit(1);
});
