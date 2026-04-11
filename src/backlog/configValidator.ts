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

const CRITICAL_FIELD_CHECKS: BacklogFieldCheck[] = [
  { envKey: "BACKLOG_FIELD_CONTRACT_TYPE", label: "契約種別" },
  { envKey: "BACKLOG_FIELD_COUNTERPARTY", label: "相手方" },
  { envKey: "BACKLOG_FIELD_DEADLINE", label: "希望期限" },
  { envKey: "BACKLOG_FIELD_REMARKS", label: "備考" },
  { envKey: "BACKLOG_FIELD_COUNTERPARTY_ADDRESS", label: "相手方所在地" },
  { envKey: "BACKLOG_FIELD_COUNTERPARTY_REP", label: "相手方代表者" },
  { envKey: "BACKLOG_FIELD_LICENSE_KEY", label: "紐付けライセンス課題キー" },
  { envKey: "BACKLOG_FIELD_COMPLETION_DATE", label: "製造完了日" },
  { envKey: "BACKLOG_FIELD_REPORT_PERIOD_END", label: "報告対象期間終了" },
  { envKey: "BACKLOG_FIELD_S1_REPORT_DUE", label: "報告期限" },
  { envKey: "BACKLOG_FIELD_S1_PAYMENT_DUE", label: "支払期限" },
];

const NON_BLOCKING_PRIMARY_REQUEST_TYPES = new Set<DocumentRequestType>([
  "ip_overseas_master",
  "ip_overseas_amendment",
]);

const REQUEST_TYPE_FIELD_CHECKS: Partial<Record<DocumentRequestType, BacklogFieldCheck[]>> = {
  nda: [
    { envKey: "BACKLOG_FIELD_NDA_PURPOSE", label: "秘密保持の目的" },
    { envKey: "BACKLOG_FIELD_CONTRACT_PERIOD", label: "契約期間" },
    { envKey: "BACKLOG_FIELD_CONFIDENTIALITY_PERIOD", label: "秘密保持期間" },
    { envKey: "BACKLOG_FIELD_JURISDICTION", label: "管轄裁判所" },
  ],
  outsourcing: [
    { envKey: "BACKLOG_FIELD_CONTRACT_PERIOD", label: "契約期間" },
    { envKey: "BACKLOG_FIELD_JURISDICTION", label: "管轄裁判所" },
  ],
  license: [
    { envKey: "BACKLOG_FIELD_ORIGINAL_WORK", label: "原著作物" },
    { envKey: "BACKLOG_FIELD_ORIGINAL_AUTHOR", label: "原著作者" },
    { envKey: "BACKLOG_FIELD_CREDIT_NAME", label: "クレジット表記" },
    { envKey: "BACKLOG_FIELD_JURISDICTION", label: "管轄裁判所" },
  ],
  license_schedule: [
    { envKey: "BACKLOG_FIELD_LICENSE_KEY", label: "紐付けライセンス課題キー" },
    { envKey: "BACKLOG_FIELD_LICENSE_TYPE_NAME", label: "許諾区分" },
    { envKey: "BACKLOG_FIELD_ORIGINAL_WORK", label: "対象作品・原著作物" },
    { envKey: "BACKLOG_FIELD_LICENSE_START", label: "許諾開始日" },
  ],
  ip_overseas_master: [
    { envKey: "BACKLOG_FIELD_DEAL_STRUCTURE", label: "取引構造" },
    { envKey: "BACKLOG_FIELD_ORIGINAL_WORK", label: "原著作物・IP名" },
    { envKey: "BACKLOG_FIELD_JURISDICTION", label: "管轄裁判所" },
    { envKey: "BACKLOG_FIELD_LICENSE_SCOPE", label: "許諾対象" },
    { envKey: "BACKLOG_FIELD_IP_PRODUCT_SCOPE", label: "商品範囲" },
    { envKey: "BACKLOG_FIELD_TERRITORY", label: "地域・言語" },
  ],
  ip_overseas_amendment: [
    { envKey: "BACKLOG_FIELD_BASE_AGREEMENT_KEY", label: "元契約課題キー" },
    { envKey: "BACKLOG_FIELD_EFFECTIVE_DATE", label: "変更効力発生日" },
    { envKey: "BACKLOG_FIELD_CHANGE_MODE", label: "変更モード" },
    { envKey: "BACKLOG_FIELD_DEAL_STRUCTURE", label: "変更後の取引構造" },
  ],
  sales_buyer: [
    { envKey: "BACKLOG_FIELD_PRODUCT_SCOPE", label: "商品範囲" },
    { envKey: "BACKLOG_FIELD_DELIVERY_LOCATION", label: "納入場所" },
    { envKey: "BACKLOG_FIELD_INSPECTION_PERIOD_DAYS", label: "検収期間" },
    { envKey: "BACKLOG_FIELD_PAYMENT_CONDITION_SUMMARY", label: "支払条件概要" },
  ],
  sales_seller_standard: [
    { envKey: "BACKLOG_FIELD_PRODUCT_SCOPE", label: "商品範囲" },
    { envKey: "BACKLOG_FIELD_PAYMENT_CONDITION_SUMMARY", label: "支払条件概要" },
    { envKey: "BACKLOG_FIELD_MONTHLY_CLOSING_DAY", label: "月末締め日" },
    { envKey: "BACKLOG_FIELD_PAYMENT_DUE_DAY", label: "支払期日" },
    { envKey: "BACKLOG_FIELD_PAYMENT_METHOD", label: "支払方法" },
  ],
  sales_seller_credit: [
    { envKey: "BACKLOG_FIELD_PRODUCT_SCOPE", label: "商品範囲" },
    { envKey: "BACKLOG_FIELD_PAYMENT_CONDITION_SUMMARY", label: "支払条件概要" },
    { envKey: "BACKLOG_FIELD_MONTHLY_CLOSING_DAY", label: "月末締め日" },
    { envKey: "BACKLOG_FIELD_PAYMENT_DUE_DAY", label: "支払期日" },
    { envKey: "BACKLOG_FIELD_PAYMENT_METHOD", label: "支払方法" },
    { envKey: "BACKLOG_FIELD_SECURITY_DEPOSIT_AMOUNT", label: "保証金額" },
    { envKey: "BACKLOG_FIELD_DEPOSIT_REPLENISH_DAYS", label: "保証金補充期限" },
  ],
  purchase_order: [
    { envKey: "BACKLOG_FIELD_PROJECT_TITLE", label: "案件名" },
    { envKey: "BACKLOG_FIELD_PAYMENT_CONDITION_SUMMARY", label: "発注概要" },
  ],
  planning_order: [
    { envKey: "BACKLOG_FIELD_PROJECT_TITLE", label: "案件名" },
    { envKey: "BACKLOG_FIELD_MASTER_CONTRACT_REF", label: "マスター契約参照" },
  ],
  publishing_order: [
    { envKey: "BACKLOG_FIELD_PROJECT_TITLE", label: "案件名" },
    { envKey: "BACKLOG_FIELD_MASTER_CONTRACT_REF", label: "マスター契約参照" },
    { envKey: "BACKLOG_FIELD_FINAL_DEADLINE", label: "校了予定・最終締切" },
    { envKey: "BACKLOG_FIELD_ACCEPT_REPLY_DUE_DATE", label: "検収回答期限" },
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
    { envKey: "BACKLOG_FIELD_REPORT_PERIOD_START", label: "報告対象期間開始" },
    { envKey: "BACKLOG_FIELD_REPORT_PERIOD_END", label: "報告対象期間終了" },
    { envKey: "BACKLOG_FIELD_NET_SALES", label: "売上高・正味売上高" },
  ],
};

const OPTIONAL_REQUEST_TYPE_FIELD_CHECKS: Partial<Record<DocumentRequestType, BacklogFieldCheck[]>> = {
  delivery_request: [
    { envKey: "BACKLOG_FIELD_INSPECTION_DATE", label: "検収日" },
    { envKey: "BACKLOG_FIELD_PAYMENT_PLANNED_DATE", label: "支払予定日" },
    { envKey: "BACKLOG_FIELD_FINAL_DEADLINE", label: "納期 / 校了予定" },
  ],
  license_schedule: [
    { envKey: "BACKLOG_FIELD_MATERIAL_CODE", label: "素材番号" },
    { envKey: "BACKLOG_FIELD_MATERIAL_NAME", label: "素材名" },
    { envKey: "BACKLOG_FIELD_MATERIAL_RIGHTS_HOLDER", label: "素材権利者" },
    { envKey: "BACKLOG_FIELD_SUPERVISOR", label: "監修者" },
    { envKey: "BACKLOG_FIELD_CONDITION1_REGION_LANGUAGE_LABEL", label: "金銭条件1 地域・言語" },
    { envKey: "BACKLOG_FIELD_CONDITION1_CALC_METHOD", label: "金銭条件1 計算方式" },
    { envKey: "BACKLOG_FIELD_CONDITION1_FORMULA", label: "金銭条件1 計算式" },
    { envKey: "BACKLOG_FIELD_CONDITION1_BASE_PRICE_LABEL", label: "金銭条件1 基準価格ラベル" },
    { envKey: "BACKLOG_FIELD_CONDITION1_RATE", label: "金銭条件1 料率" },
    { envKey: "BACKLOG_FIELD_CONDITION1_PAYMENT_TERMS", label: "金銭条件1 支払条件" },
    { envKey: "BACKLOG_FIELD_CONDITION1_MG_AG", label: "金銭条件1 MG/AG" },
    { envKey: "BACKLOG_FIELD_CONDITION1_NOTE", label: "金銭条件1 補足" },
    { envKey: "BACKLOG_FIELD_CONDITION2_HEADING", label: "金銭条件2 見出し" },
    { envKey: "BACKLOG_FIELD_CONDITION2_REGION", label: "金銭条件2 地域" },
    { envKey: "BACKLOG_FIELD_CONDITION2_LANGUAGE", label: "金銭条件2 言語" },
    { envKey: "BACKLOG_FIELD_CONDITION2_CALC_METHOD", label: "金銭条件2 計算方式" },
    { envKey: "BACKLOG_FIELD_CONDITION2_SUMMARY", label: "金銭条件2 概要" },
    { envKey: "BACKLOG_FIELD_CONDITION2_FORMULA", label: "金銭条件2 計算式" },
    { envKey: "BACKLOG_FIELD_CONDITION2_SHARE_RATE", label: "金銭条件2 分配率" },
    { envKey: "BACKLOG_FIELD_CONDITION2_PAYMENT_TERMS", label: "金銭条件2 支払条件" },
    { envKey: "BACKLOG_FIELD_CONDITION2_MG_AG", label: "金銭条件2 MG/AG" },
    { envKey: "BACKLOG_FIELD_CONDITION2_NOTE", label: "金銭条件2 補足" },
    { envKey: "BACKLOG_FIELD_CONDITION3_HEADING", label: "金銭条件3 見出し" },
    { envKey: "BACKLOG_FIELD_CONDITION3_REGION", label: "金銭条件3 地域" },
    { envKey: "BACKLOG_FIELD_CONDITION3_LANGUAGE", label: "金銭条件3 言語" },
    { envKey: "BACKLOG_FIELD_CONDITION3_CALC_METHOD", label: "金銭条件3 計算方式" },
    { envKey: "BACKLOG_FIELD_CONDITION3_SUMMARY", label: "金銭条件3 概要" },
    { envKey: "BACKLOG_FIELD_CONDITION3_FORMULA", label: "金銭条件3 計算式" },
    { envKey: "BACKLOG_FIELD_CONDITION3_RATE", label: "金銭条件3 料率" },
    { envKey: "BACKLOG_FIELD_CONDITION3_PAYMENT_TERMS", label: "金銭条件3 支払条件" },
    { envKey: "BACKLOG_FIELD_CONDITION3_MG_AG", label: "金銭条件3 MG/AG" },
    { envKey: "BACKLOG_FIELD_CONDITION3_NOTE", label: "金銭条件3 補足" },
  ],
};

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
      const exists = issueTypeNames.has(definition.backlogIssueTypeName);
      issueTypeResults.push({
        requestType: definition.value,
        backlogIssueTypeName: definition.backlogIssueTypeName,
        workflowKind: definition.workflowKind,
        status: exists ? "ok" : "missing",
      });
      const isBlockingRequestType =
        definition.workflowKind === "primary" && !NON_BLOCKING_PRIMARY_REQUEST_TYPES.has(definition.value);
      if (!exists) {
        const message = `課題タイプ不足: ${definition.backlogIssueTypeName} (${definition.value})`;
        warnings.push(message);
        if (isBlockingRequestType) {
          blockingIssues.push(message);
        }
      }
    }

    for (const check of CRITICAL_FIELD_CHECKS) {
      pushFieldWarning(warnings, blockingIssues, fieldResults, customFieldMap, check, true);
    }

    for (const definition of DOCUMENT_REQUEST_DEFINITIONS) {
      const isBlockingRequestType =
        definition.workflowKind === "primary" && !NON_BLOCKING_PRIMARY_REQUEST_TYPES.has(definition.value);
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
