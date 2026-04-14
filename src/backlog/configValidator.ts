import { backlog } from "./client";
import { DOCUMENT_REQUEST_DEFINITIONS } from "../workflow/documentRequestConfig";
import { DocumentRequestType } from "../workflow/documentRequestConfig";

type BacklogFieldCheck = {
  envKey: string;
  label: string;
};

export interface BacklogFieldValidationItem {
  envKey: string;
  label: string;
  requestType?: string;
  configuredValue?: string;
  status: "ok" | "missing_env" | "invalid_env" | "missing_in_backlog";
}

export interface BacklogIssueTypeValidationItem {
  requestType: string;
  backlogIssueTypeName: string;
  workflowKind: "primary" | "followup";
  status: "ok" | "missing";
}

export interface BacklogConfigurationValidationResult {
  warnings: string[];
  blockingIssues: string[];
  issueTypes: BacklogIssueTypeValidationItem[];
  fields: BacklogFieldValidationItem[];
}

const BASELINE_FIELD_CHECKS: BacklogFieldCheck[] = [
  { envKey: "BACKLOG_FIELD_COUNTERPARTY", label: "相手方" },
  { envKey: "BACKLOG_FIELD_DEADLINE", label: "希望期限" },
  { envKey: "BACKLOG_FIELD_REMARKS", label: "備考" },
];

const REQUEST_TYPE_FIELD_CHECKS: Partial<Record<DocumentRequestType, BacklogFieldCheck[]>> = {
  nda: [
    { envKey: "BACKLOG_FIELD_CONTRACT_DATE", label: "契約日" },
    { envKey: "BACKLOG_FIELD_CONTRACT_PERIOD", label: "契約期間" },
  ],
  outsourcing: [
    { envKey: "BACKLOG_FIELD_CONTRACT_DATE", label: "契約日" },
    { envKey: "BACKLOG_FIELD_CONTRACT_PERIOD", label: "契約期間" },
  ],
  license: [
    { envKey: "BACKLOG_FIELD_CONTRACT_DATE", label: "契約日" },
    { envKey: "BACKLOG_FIELD_CONTRACT_PERIOD", label: "契約期間" },
  ],
  license_schedule: [
    { envKey: "BACKLOG_FIELD_LICENSE_KEY", label: "紐付けライセンス課題キー" },
    { envKey: "BACKLOG_FIELD_LICENSE_START", label: "許諾開始日" },
  ],
  ip_overseas_master: [
    { envKey: "BACKLOG_FIELD_CONTRACT_DATE", label: "契約日" },
    { envKey: "BACKLOG_FIELD_CONTRACT_PERIOD", label: "契約期間" },
  ],
  ip_overseas_amendment: [
    { envKey: "BACKLOG_FIELD_CONTRACT_DATE", label: "契約日" },
    { envKey: "BACKLOG_FIELD_CONTRACT_PERIOD", label: "契約期間" },
  ],
  sales_buyer: [
    { envKey: "BACKLOG_FIELD_CONTRACT_DATE", label: "契約日" },
    { envKey: "BACKLOG_FIELD_CONTRACT_PERIOD", label: "契約期間" },
  ],
  sales_seller_standard: [
    { envKey: "BACKLOG_FIELD_CONTRACT_DATE", label: "契約日" },
    { envKey: "BACKLOG_FIELD_CONTRACT_PERIOD", label: "契約期間" },
  ],
  sales_seller_credit: [
    { envKey: "BACKLOG_FIELD_CONTRACT_DATE", label: "契約日" },
    { envKey: "BACKLOG_FIELD_CONTRACT_PERIOD", label: "契約期間" },
  ],
  purchase_order: [
    { envKey: "BACKLOG_FIELD_CONTRACT_DATE", label: "発注日" },
    { envKey: "BACKLOG_FIELD_PROJECT_TITLE", label: "案件名" },
  ],
  planning_order: [
    { envKey: "BACKLOG_FIELD_CONTRACT_DATE", label: "発注日" },
    { envKey: "BACKLOG_FIELD_PROJECT_TITLE", label: "案件名" },
  ],
  publishing_order: [
    { envKey: "BACKLOG_FIELD_CONTRACT_DATE", label: "発注日" },
    { envKey: "BACKLOG_FIELD_PROJECT_TITLE", label: "案件名" },
  ],
  delivery_request: [
    { envKey: "BACKLOG_FIELD_PARENT_ISSUE_KEY", label: "親課題キー" },
    { envKey: "BACKLOG_FIELD_ITEM_NO", label: "明細番号" },
    { envKey: "BACKLOG_FIELD_DELIVERED_AMOUNT", label: "今回納品金額" },
    { envKey: "BACKLOG_FIELD_DELIVERY_NOTE", label: "納品備考" },
  ],
  royalty_calculation_manufacturing: [
    { envKey: "BACKLOG_FIELD_LICENSE_KEY", label: "紐付けライセンス課題キー" },
    { envKey: "BACKLOG_FIELD_PRODUCT_NAME", label: "製品名" },
    { envKey: "BACKLOG_FIELD_COMPLETION_DATE", label: "製造完了日" },
    { envKey: "BACKLOG_FIELD_QUANTITY", label: "製造数量" },
    { envKey: "BACKLOG_FIELD_MSRP", label: "MSRP" },
  ],
  royalty_calculation_sales_report: [
    { envKey: "BACKLOG_FIELD_LICENSE_KEY", label: "紐付けライセンス課題キー" },
    { envKey: "BACKLOG_FIELD_PRODUCT_NAME", label: "対象商品・報告単位名" },
    { envKey: "BACKLOG_FIELD_REPORT_PERIOD_END", label: "報告対象期間終了" },
    { envKey: "BACKLOG_FIELD_NET_SALES", label: "売上高・正味売上高" },
  ],
};

const OPTIONAL_REQUEST_TYPE_FIELD_CHECKS: Partial<Record<DocumentRequestType, BacklogFieldCheck[]>> = {
  delivery_request: [
    { envKey: "BACKLOG_FIELD_FINAL_DEADLINE", label: "納期 / 校了予定" },
  ],
};

const HEALTHCHECK_SKIPPED_REQUEST_TYPES = new Set<DocumentRequestType>([
  "ip_overseas_master",
  "ip_overseas_amendment",
]);

export async function validateBacklogConfiguration(): Promise<BacklogConfigurationValidationResult> {
  try {
    const [issueTypes, customFields] = await Promise.all([
      backlog.listIssueTypes(),
      backlog.listCustomFields(),
    ]);

    const issueTypeNames = new Set(issueTypes.map((issueType) => issueType.name));
    const customFieldMap = new Map(customFields.map((field) => [field.id, field.name]));
    const warnings: string[] = [];
    const blockingIssues: string[] = [];
    const issueTypeResults: BacklogIssueTypeValidationItem[] = [];
    const fieldResults: BacklogFieldValidationItem[] = [];

    for (const definition of DOCUMENT_REQUEST_DEFINITIONS) {
      if (HEALTHCHECK_SKIPPED_REQUEST_TYPES.has(definition.value)) {
        continue;
      }
      const exists = issueTypeNames.has(definition.backlogIssueTypeName);
      issueTypeResults.push({
        requestType: definition.value,
        backlogIssueTypeName: definition.backlogIssueTypeName,
        workflowKind: definition.workflowKind,
        status: exists ? "ok" : "missing",
      });
      if (!exists) {
        const message = `課題タイプ不足: ${definition.backlogIssueTypeName} (${definition.value})`;
        warnings.push(message);
      }
    }

    // Backlog は「ステータス管理 + 最小ヘッダ」に寄せる方針のため、
    // 共通ヘッダ項目の不足は warning に留め、blocking は接続障害のみに限定する。
    for (const check of BASELINE_FIELD_CHECKS) {
      pushFieldWarning(warnings, blockingIssues, fieldResults, customFieldMap, check, false);
    }

    for (const definition of DOCUMENT_REQUEST_DEFINITIONS) {
      if (HEALTHCHECK_SKIPPED_REQUEST_TYPES.has(definition.value)) {
        continue;
      }
      const isBlockingRequestType = false;
      const checks = REQUEST_TYPE_FIELD_CHECKS[definition.value] ?? [];
      for (const check of checks) {
        pushFieldWarning(
          warnings,
          blockingIssues,
          fieldResults,
          customFieldMap,
          check,
          isBlockingRequestType,
          definition.value,
        );
      }

      const optionalChecks = OPTIONAL_REQUEST_TYPE_FIELD_CHECKS[definition.value] ?? [];
      for (const check of optionalChecks) {
        pushFieldWarning(
          warnings,
          blockingIssues,
          fieldResults,
          customFieldMap,
          check,
          false,
          definition.value,
        );
      }
    }

    if (warnings.length === 0) {
      console.log("[BacklogConfig] 起動時チェックOK: 課題タイプと主要カスタム属性の整合性を確認しました。");
      return { warnings, blockingIssues, issueTypes: issueTypeResults, fields: fieldResults };
    }

    console.warn("[BacklogConfig] 起動時チェックで設定差分を検出しました。");
    for (const warning of warnings) {
      console.warn(`  - ${warning}`);
    }
    console.warn("[BacklogConfig] blocking issue は受付主線に影響し、warning は拡張属性や補助設定の不足を示します。");
    return { warnings, blockingIssues, issueTypes: issueTypeResults, fields: fieldResults };
  } catch (error) {
    console.warn("[BacklogConfig] 起動時チェックを完了できませんでした。Backlog API 接続と設定を確認してください。");
    console.warn(error);
    return {
      warnings: ["Backlog API 接続または設定確認に失敗しました。"],
      blockingIssues: ["Backlog API 接続または設定確認に失敗しました。"],
      issueTypes: [],
      fields: [],
    };
  }
}

function pushFieldWarning(
  warnings: string[],
  blockingIssues: string[],
  fieldResults: BacklogFieldValidationItem[],
  customFieldMap: Map<number, string>,
  check: BacklogFieldCheck,
  isBlocking: boolean,
  requestType?: string,
): void {
  const raw = String(process.env[check.envKey] ?? "").trim();
  const scopeLabel = requestType ? ` / ${requestType}` : "";
  if (!raw) {
    const message = `環境変数未設定: ${check.envKey} (${check.label}${scopeLabel})`;
    warnings.push(message);
    fieldResults.push({
      envKey: check.envKey,
      label: check.label,
      requestType,
      configuredValue: raw || undefined,
      status: "missing_env",
    });
    if (isBlocking) {
      blockingIssues.push(message);
    }
    return;
  }
  if (!/^\d+$/.test(raw)) {
    const message = `属性ID形式不正: ${check.envKey}=${raw} (${check.label}${scopeLabel})`;
    warnings.push(message);
    fieldResults.push({
      envKey: check.envKey,
      label: check.label,
      requestType,
      configuredValue: raw,
      status: "invalid_env",
    });
    if (isBlocking) {
      blockingIssues.push(message);
    }
    return;
  }
  if (!customFieldMap.has(Number(raw))) {
    const message = `Backlog属性未検出: ${check.envKey}=${raw} (${check.label}${scopeLabel})`;
    warnings.push(message);
    fieldResults.push({
      envKey: check.envKey,
      label: check.label,
      requestType,
      configuredValue: raw,
      status: "missing_in_backlog",
    });
    if (isBlocking) {
      blockingIssues.push(message);
    }
    return;
  }
  fieldResults.push({
    envKey: check.envKey,
    label: check.label,
    requestType,
    configuredValue: raw,
    status: "ok",
  });
}
