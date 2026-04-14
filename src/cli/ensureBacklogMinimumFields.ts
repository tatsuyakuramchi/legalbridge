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
    name: "契約日・発注日",
    description: "契約系または発注系の主ヘッダ日付。",
    typeId: FIELD_TYPE.date,
    required: false,
    issueTypeEnvKeys: [
      "BACKLOG_ISSUE_TYPE_NDA",
      "BACKLOG_ISSUE_TYPE_OUTSOURCING",
      "BACKLOG_ISSUE_TYPE_LICENSE",
      "BACKLOG_ISSUE_TYPE_IP_OVERSEAS_MASTER",
      "BACKLOG_ISSUE_TYPE_IP_OVERSEAS_AMENDMENT",
      "BACKLOG_ISSUE_TYPE_SALES_BUYER",
      "BACKLOG_ISSUE_TYPE_SALES_SELLER_STANDARD",
      "BACKLOG_ISSUE_TYPE_SALES_SELLER_CREDIT",
      "BACKLOG_ISSUE_TYPE_PURCHASE_ORDER",
      "BACKLOG_ISSUE_TYPE_PLANNING_ORDER",
      "BACKLOG_ISSUE_TYPE_PUBLISHING_ORDER",
    ],
  },
  {
    envKey: "BACKLOG_FIELD_CONTRACT_PERIOD",
    name: "契約期間",
    description: "契約系で任意に保持する期間情報。",
    typeId: FIELD_TYPE.text,
    required: false,
    issueTypeEnvKeys: [
      "BACKLOG_ISSUE_TYPE_NDA",
      "BACKLOG_ISSUE_TYPE_OUTSOURCING",
      "BACKLOG_ISSUE_TYPE_LICENSE",
      "BACKLOG_ISSUE_TYPE_IP_OVERSEAS_MASTER",
      "BACKLOG_ISSUE_TYPE_IP_OVERSEAS_AMENDMENT",
      "BACKLOG_ISSUE_TYPE_SALES_BUYER",
      "BACKLOG_ISSUE_TYPE_SALES_SELLER_STANDARD",
      "BACKLOG_ISSUE_TYPE_SALES_SELLER_CREDIT",
    ],
  },
  {
    envKey: "BACKLOG_FIELD_REMARKS",
    name: "備考",
    description: "Backlog 上で任意に保持する補足メモ。",
    typeId: FIELD_TYPE.multiline,
    required: false,
    issueTypeEnvKeys: [
      "BACKLOG_ISSUE_TYPE_OUTSOURCING",
      "BACKLOG_ISSUE_TYPE_LICENSE",
      "BACKLOG_ISSUE_TYPE_IP_OVERSEAS_MASTER",
      "BACKLOG_ISSUE_TYPE_IP_OVERSEAS_AMENDMENT",
      "BACKLOG_ISSUE_TYPE_SALES_BUYER",
      "BACKLOG_ISSUE_TYPE_SALES_SELLER_STANDARD",
      "BACKLOG_ISSUE_TYPE_SALES_SELLER_CREDIT",
      "BACKLOG_ISSUE_TYPE_PURCHASE_ORDER",
      "BACKLOG_ISSUE_TYPE_PLANNING_ORDER",
      "BACKLOG_ISSUE_TYPE_PUBLISHING_ORDER",
    ],
  },
  {
    envKey: "BACKLOG_FIELD_CONTRACT_NO",
    name: "文書番号",
    description: "自動採番で保持する識別情報。",
    typeId: FIELD_TYPE.text,
    required: false,
    issueTypeEnvKeys: [
      "BACKLOG_ISSUE_TYPE_NDA",
      "BACKLOG_ISSUE_TYPE_OUTSOURCING",
      "BACKLOG_ISSUE_TYPE_LICENSE",
      "BACKLOG_ISSUE_TYPE_IP_OVERSEAS_MASTER",
      "BACKLOG_ISSUE_TYPE_IP_OVERSEAS_AMENDMENT",
      "BACKLOG_ISSUE_TYPE_SALES_BUYER",
      "BACKLOG_ISSUE_TYPE_SALES_SELLER_STANDARD",
      "BACKLOG_ISSUE_TYPE_SALES_SELLER_CREDIT",
      "BACKLOG_ISSUE_TYPE_PURCHASE_ORDER",
      "BACKLOG_ISSUE_TYPE_PLANNING_ORDER",
      "BACKLOG_ISSUE_TYPE_PUBLISHING_ORDER",
    ],
  },
  {
    envKey: "BACKLOG_FIELD_PROJECT_TITLE",
    name: "案件名",
    description: "発注書系で任意に保持する親課題ヘッダ。",
    typeId: FIELD_TYPE.text,
    required: false,
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
    name: "親ライセンス課題キー",
    description: "関連するライセンス課題キー。",
    typeId: FIELD_TYPE.text,
    required: false,
    issueTypeEnvKeys: [
      "BACKLOG_ISSUE_TYPE_LICENSE_SCHEDULE",
      "BACKLOG_ISSUE_TYPE_MFG",
      "BACKLOG_ISSUE_TYPE_ROYALTY_SALES",
    ],
  },
  {
    envKey: "BACKLOG_FIELD_LICENSE_TYPE_NAME",
    name: "許諾区分",
    description: "個別利用許諾条件の補足区分。",
    typeId: FIELD_TYPE.text,
    required: false,
    issueTypeEnvKeys: ["BACKLOG_ISSUE_TYPE_LICENSE_SCHEDULE"],
  },
  {
    envKey: "BACKLOG_FIELD_LICENSE_START",
    name: "許諾開始日",
    description: "個別利用許諾条件の開始日。",
    typeId: FIELD_TYPE.date,
    required: false,
    issueTypeEnvKeys: ["BACKLOG_ISSUE_TYPE_LICENSE_SCHEDULE"],
  },
  {
    envKey: "BACKLOG_FIELD_TERRITORY",
    name: "許諾地域・言語",
    description: "個別利用許諾条件の任意補足。",
    typeId: FIELD_TYPE.text,
    required: false,
    issueTypeEnvKeys: ["BACKLOG_ISSUE_TYPE_LICENSE_SCHEDULE"],
  },
  {
    envKey: "BACKLOG_FIELD_PARENT_ISSUE_KEY",
    name: "親課題キー",
    description: "納品リクエストの親参照。",
    typeId: FIELD_TYPE.text,
    required: false,
    issueTypeEnvKeys: ["BACKLOG_ISSUE_TYPE_DELIVERY"],
  },
  {
    envKey: "BACKLOG_FIELD_ITEM_NO",
    name: "明細番号",
    description: "1明細1課題の識別子。",
    typeId: FIELD_TYPE.text,
    required: false,
    issueTypeEnvKeys: ["BACKLOG_ISSUE_TYPE_DELIVERY"],
  },
  {
    envKey: "BACKLOG_FIELD_DELIVERY_NOTE",
    name: "納品備考",
    description: "納品・検収帳票の補足。",
    typeId: FIELD_TYPE.multiline,
    required: false,
    issueTypeEnvKeys: ["BACKLOG_ISSUE_TYPE_DELIVERY"],
  },
  {
    envKey: "BACKLOG_FIELD_FINAL_DEADLINE",
    name: "納期 / 校了予定",
    description: "納品管理で任意に保持する期日。",
    typeId: FIELD_TYPE.date,
    required: false,
    issueTypeEnvKeys: ["BACKLOG_ISSUE_TYPE_DELIVERY"],
  },
  {
    envKey: "BACKLOG_FIELD_INSPECTION_DATE",
    name: "検収日",
    description: "納品リクエストで任意に保持する検収日。",
    typeId: FIELD_TYPE.date,
    required: false,
    issueTypeEnvKeys: ["BACKLOG_ISSUE_TYPE_DELIVERY"],
  },
  {
    envKey: "BACKLOG_FIELD_PAYMENT_PLANNED_DATE",
    name: "支払予定日",
    description: "納品リクエストで任意に保持する支払予定日。",
    typeId: FIELD_TYPE.date,
    required: false,
    issueTypeEnvKeys: ["BACKLOG_ISSUE_TYPE_DELIVERY"],
  },
  {
    envKey: "BACKLOG_FIELD_PRODUCT_NAME",
    name: "製品名 / 対象商品名",
    description: "製品名または売上報告の対象商品名。",
    typeId: FIELD_TYPE.text,
    required: false,
    issueTypeEnvKeys: [
      "BACKLOG_ISSUE_TYPE_MFG",
      "BACKLOG_ISSUE_TYPE_ROYALTY_SALES",
    ],
  },
  {
    envKey: "BACKLOG_FIELD_EDITION",
    name: "版",
    description: "利用許諾料計算で任意に保持する版情報。",
    typeId: FIELD_TYPE.text,
    required: false,
    issueTypeEnvKeys: ["BACKLOG_ISSUE_TYPE_MFG"],
  },
  {
    envKey: "BACKLOG_FIELD_COMPLETION_DATE",
    name: "製造完了日",
    description: "製造ベース計算の基準日。",
    typeId: FIELD_TYPE.date,
    required: false,
    issueTypeEnvKeys: ["BACKLOG_ISSUE_TYPE_MFG"],
  },
  {
    envKey: "BACKLOG_FIELD_QUANTITY",
    name: "数量",
    description: "製造数量。",
    typeId: FIELD_TYPE.numeric,
    required: false,
    issueTypeEnvKeys: ["BACKLOG_ISSUE_TYPE_MFG"],
  },
  {
    envKey: "BACKLOG_FIELD_MSRP",
    name: "MSRP",
    description: "希望小売価格。",
    typeId: FIELD_TYPE.numeric,
    required: false,
    issueTypeEnvKeys: ["BACKLOG_ISSUE_TYPE_MFG"],
  },
  {
    envKey: "BACKLOG_FIELD_SAMPLE_QUANTITY",
    name: "サンプル数量",
    description: "利用許諾料計算で任意に保持するサンプル数量。",
    typeId: FIELD_TYPE.numeric,
    required: false,
    issueTypeEnvKeys: ["BACKLOG_ISSUE_TYPE_MFG"],
  },
  {
    envKey: "BACKLOG_FIELD_REPORT_PERIOD_START",
    name: "報告対象期間開始",
    description: "売上報告ベース計算で任意に保持する開始日。",
    typeId: FIELD_TYPE.date,
    required: false,
    issueTypeEnvKeys: ["BACKLOG_ISSUE_TYPE_ROYALTY_SALES"],
  },
  {
    envKey: "BACKLOG_FIELD_REPORT_PERIOD_END",
    name: "報告対象期間終了",
    description: "売上報告ベース計算の基準終了日。",
    typeId: FIELD_TYPE.date,
    required: false,
    issueTypeEnvKeys: ["BACKLOG_ISSUE_TYPE_ROYALTY_SALES"],
  },
  {
    envKey: "BACKLOG_FIELD_NET_SALES",
    name: "売上高・正味売上高",
    description: "売上報告ベース計算で保持する売上額。",
    typeId: FIELD_TYPE.numeric,
    required: false,
    issueTypeEnvKeys: ["BACKLOG_ISSUE_TYPE_ROYALTY_SALES"],
  },
  {
    envKey: "BACKLOG_FIELD_S1_REPORT_DUE",
    name: "報告期限",
    description: "報告期限。",
    typeId: FIELD_TYPE.date,
    required: false,
    issueTypeEnvKeys: [
      "BACKLOG_ISSUE_TYPE_MFG",
      "BACKLOG_ISSUE_TYPE_ROYALTY_SALES",
    ],
  },
  {
    envKey: "BACKLOG_FIELD_S1_PAYMENT_DUE",
    name: "支払期限",
    description: "支払期限。",
    typeId: FIELD_TYPE.date,
    required: false,
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
