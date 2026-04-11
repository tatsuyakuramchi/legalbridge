import { DOCUMENT_REQUEST_DEFINITIONS } from "../workflow/documentRequestConfig";
import { getDefaultDriveFolderKey, listDriveFolderOptions } from "../documents/driveFolders";

export type ModalValueMap = Record<string, string>;

const CONTRACT_TYPES = DOCUMENT_REQUEST_DEFINITIONS.filter(
  (item) => item.value !== "license_schedule" && item.value !== "purchase_order"
).map((item) => ({
  text: item.text,
  value: item.value,
}));

const PRIMARY_REQUEST_TYPES = [
  { text: "レビュー依頼", value: "legal_review" },
  { text: "法務相談", value: "legal_consultation" },
  { text: "秘密保持契約（NDA）", value: "nda" },
  { text: "業務委託基本契約", value: "outsourcing" },
  { text: "ライセンス契約", value: "license" },
  { text: "海外IP契約", value: "ip_overseas_master" },
  { text: "売買契約", value: "sales_buyer" },
  { text: "発注書", value: "purchase_order" },
  { text: "企画発注書", value: "planning_order" },
  { text: "出版発注書", value: "publishing_order" },
];

export function buildLegalRequestEntryModal(channelId: string, userId: string, existingMode = "new_request", existingIssueKey = "") {
  return {
    type: "modal" as const,
    callback_id: "legal_request_entry_modal",
    title: { type: "plain_text" as const, text: "法務依頼" },
    submit: { type: "plain_text" as const, text: "次へ" },
    close: { type: "plain_text" as const, text: "キャンセル" },
    private_metadata: JSON.stringify({ channelId, userId }),
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: "新規依頼か、既存課題への追記かを選んでください。" },
      },
      {
        type: "input",
        block_id: "request_mode",
        label: { type: "plain_text", text: "受付内容" },
        element: {
          type: "radio_buttons",
          action_id: "request_mode_select",
          initial_option: requestModeOption(existingMode),
          options: [
            requestModeOption("new_request"),
            requestModeOption("append_request"),
          ],
        },
      },
      {
        type: "input",
        block_id: "existing_issue_key",
        optional: true,
        label: { type: "plain_text", text: "課題キー（追記時のみ）" },
        element: {
          type: "plain_text_input",
          action_id: "input",
          initial_value: existingIssueKey,
          placeholder: { type: "plain_text", text: "例: LEGAL-123" },
        },
      },
    ],
  };
}

export function buildSimpleLegalRequestModal(
  channelId: string,
  userId: string,
  existingValues: ModalValueMap = {},
) {
  return {
    type: "modal" as const,
    callback_id: "legal_request_simple_modal",
    title: { type: "plain_text" as const, text: "新規法務依頼" },
    submit: { type: "plain_text" as const, text: "送信" },
    close: { type: "plain_text" as const, text: "キャンセル" },
    private_metadata: JSON.stringify({ channelId, userId }),
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "メール本文や依頼メモをそのまま貼り付けてください。レビュー依頼は相手方ドラフトや見積書を添付し、法務相談は確認したい論点を本文に書いてください。",
        },
      },
      {
        type: "input",
        block_id: "contract_type",
        label: { type: "plain_text", text: "依頼種別" },
        element: {
          type: "static_select",
          action_id: "simple_contract_type_select",
          initial_option: primaryContractTypeOption(existingValues.contract_type),
          options: PRIMARY_REQUEST_TYPES.map((t) => ({
            text: { type: "plain_text", text: t.text },
            value: t.value,
          })),
        },
      },
      {
        type: "input",
        block_id: "summary",
        label: { type: "plain_text", text: "件名" },
        element: {
          type: "plain_text_input",
          action_id: "input",
          initial_value: existingValues.summary ?? "",
          placeholder: { type: "plain_text", text: "例: AG商品カタログ2026 デザイン費 発注書作成依頼" },
        },
      },
      {
        type: "input",
        block_id: "notes",
        label: { type: "plain_text", text: "依頼内容" },
        element: {
          type: "plain_text_input",
          action_id: "input",
          multiline: true,
          initial_value: existingValues.notes ?? "",
          placeholder: { type: "plain_text", text: "メール本文、背景、金額条件、急ぎ事情、見てほしい点など" },
        },
      },
      {
        type: "input",
        block_id: "deadline",
        optional: true,
        label: { type: "plain_text", text: "希望納期（任意）" },
        element: {
          type: "datepicker",
          action_id: "datepicker",
          initial_date: existingValues.deadline || undefined,
        },
      },
      {
        type: "input",
        block_id: "counterparty",
        optional: true,
        label: { type: "plain_text", text: "相手先名（任意）" },
        element: {
          type: "plain_text_input",
          action_id: "input",
          initial_value: existingValues.counterparty ?? "",
          placeholder: { type: "plain_text", text: "例: iDクリエイティブ様" },
        },
      },
      {
        type: "input",
        block_id: "request_attachments",
        optional: true,
        label: { type: "plain_text", text: "添付ファイル（任意）" },
        element: {
          type: "file_input",
          action_id: "file_input",
          max_files: 10,
        },
      },
    ],
  };
}

export function buildLegalRequestAppendModal(
  channelId: string,
  userId: string,
  existingValues: ModalValueMap = {},
) {
  return {
    type: "modal" as const,
    callback_id: "legal_request_append_modal",
    title: { type: "plain_text" as const, text: "課題へ追記" },
    submit: { type: "plain_text" as const, text: "追記する" },
    close: { type: "plain_text" as const, text: "キャンセル" },
    private_metadata: JSON.stringify({ channelId, userId }),
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: "起案済みの Backlog 課題へ、追加資料や補足メモを追記します。" },
      },
      {
        type: "input",
        block_id: "existing_issue_key",
        label: { type: "plain_text", text: "課題キー" },
        element: {
          type: "plain_text_input",
          action_id: "input",
          initial_value: existingValues.existing_issue_key ?? "",
          placeholder: { type: "plain_text", text: "例: LEGAL-123" },
        },
      },
      {
        type: "input",
        block_id: "append_notes",
        optional: true,
        label: { type: "plain_text", text: "追記内容（任意）" },
        element: {
          type: "plain_text_input",
          action_id: "input",
          multiline: true,
          initial_value: existingValues.append_notes ?? "",
          placeholder: { type: "plain_text", text: "差し替え理由、補足、確認してほしい点など" },
        },
      },
      {
        type: "input",
        block_id: "request_attachments",
        optional: true,
        label: { type: "plain_text", text: "添付ファイル（任意）" },
        element: {
          type: "file_input",
          action_id: "file_input",
          max_files: 10,
        },
      },
    ],
  };
}

export function buildRequestModal(
  channelId: string,
  userId: string,
  contractType: string,
  existingValues: ModalValueMap = {},
  dynamicBlocks: any[] = []
) {
  const isOrderType = contractType === "purchase_order" || contractType === "planning_order";
  const isConsultationType = contractType === "legal_consultation";
  const registrationRequiredTypes = new Set([
    "nda",
    "outsourcing",
    "license",
    "ip_overseas_master",
    "ip_overseas_amendment",
    "sales_buyer",
    "sales_seller_standard",
    "sales_seller_credit",
  ]);
  const counterpartyRequiredTypes = new Set([
    "nda",
    "outsourcing",
    "license",
    "ip_overseas_master",
    "ip_overseas_amendment",
    "sales_buyer",
    "sales_seller_standard",
    "sales_seller_credit",
    "purchase_order",
    "planning_order",
    "publishing_order",
  ]);
  const showRegistrationNumber = isConsultationType || registrationRequiredTypes.has(contractType);
  const showCounterparty = isConsultationType || counterpartyRequiredTypes.has(contractType);
  const deadlineLabel = "📅 文書作成希望完了日（任意）";
  const deadlineHint = isOrderType
    ? [{
        type: "context",
        elements: [{ type: "mrkdwn", text: "発注書は依頼承諾から3営業日が最短です。" }],
      }]
    : [];
  return {
    type: "modal" as const,
    callback_id: "legal_request_modal",
    title: { type: "plain_text" as const, text: "法務依頼フォーム" },
    submit: { type: "plain_text" as const, text: "送信" },
    close: { type: "plain_text" as const, text: "キャンセル" },
    private_metadata: JSON.stringify({ channelId, userId }),
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: "必要事項を入力して「送信」してください。\n法務担当より折り返しご連絡します。" },
      },
      { type: "divider" },
      {
        type: "input",
        block_id: "contract_type",
        dispatch_action: true,
        label: { type: "plain_text", text: "📄 契約種別" },
        element: {
          type: "static_select",
          action_id: "contract_type_select",
          placeholder: { type: "plain_text", text: "種別を選択" },
          initial_option: contractTypeOption(contractType),
          options: CONTRACT_TYPES.map((t) => ({
            text: { type: "plain_text", text: t.text },
            value: t.value,
          })),
        },
      },
      {
        type: "input",
        block_id: "drive_folder_key",
        label: { type: "plain_text", text: "🗂 保存先Drive" },
        element: {
          type: "static_select",
          action_id: "drive_folder_select",
          initial_option: driveFolderOption(existingValues.drive_folder_key),
          options: listDriveFolderOptions().map((option) => ({
            text: { type: "plain_text", text: option.label },
            value: option.key,
          })),
        },
      },
      ...(showRegistrationNumber
        ? [
            {
              type: "input",
              block_id: "registration_number",
              optional: isConsultationType,
              label: { type: "plain_text", text: "🏷 登録番号" },
              element: {
                type: "plain_text_input",
                action_id: "input",
                initial_value: existingValues.registration_number ?? "",
                placeholder: {
                  type: "plain_text",
                  text: isConsultationType
                    ? "レビュー対象があれば入力 / 相談のみなら空欄可"
                    : "個人は執筆者登録番号 / 法人は国税の登録番号",
                },
              },
            },
            {
              type: "context",
              elements: [
                {
                  type: "mrkdwn",
                  text: isConsultationType
                    ? "文書レビューの場合は登録番号があれば入力してください。相談のみの場合は空欄でも受け付けます。"
                    : "個人は執筆者登録番号、法人は国税の登録番号を入力してください。",
                },
              ],
            },
          ]
        : []),
      ...(showCounterparty
        ? [
            {
              type: "input",
              block_id: "counterparty",
              optional: isConsultationType,
              label: { type: "plain_text", text: isConsultationType ? "🏢 相手方・相談先" : "🏢 相手方名" },
              element: {
                type: "plain_text_input",
                action_id: "input",
                initial_value: existingValues.counterparty ?? "",
                placeholder: {
                  type: "plain_text",
                  text: isConsultationType ? "例: 株式会社○○ / 社内案件なら空欄可" : "例: 株式会社○○",
                },
              },
            },
            {
              type: "context",
              elements: [{ type: "mrkdwn", text: isConsultationType ? "レビュー対象や相談先があれば入力してください。" : "正式名称を入力してください。" }],
            },
          ]
        : []),
      {
        type: "input",
        block_id: "summary",
        label: { type: "plain_text", text: isConsultationType ? "📝 相談概要" : "📝 概要（件名）" },
        element: {
          type: "plain_text_input",
          action_id: "input",
          initial_value: existingValues.summary ?? "",
          placeholder: {
            type: "plain_text",
            text: isConsultationType
              ? "例: 他社提示NDAのレビュー / 契約なしで進めてよいか相談"
              : "例: 新商品の販売委託に関する契約",
          },
        },
      },
      ...dynamicBlocks,
      ...deadlineHint,
      {
        type: "input",
        block_id: "deadline",
        label: { type: "plain_text", text: deadlineLabel },
        optional: true,
        element: {
          type: "datepicker",
          action_id: "datepicker",
          initial_date: existingValues.deadline || undefined,
        },
      },
      {
        type: "input",
        block_id: "remarks",
        optional: true,
        label: { type: "plain_text", text: "🗒 備考（任意）" },
        element: {
          type: "plain_text_input",
          action_id: "input",
          multiline: true,
          initial_value: existingValues.remarks ?? "",
          placeholder: { type: "plain_text", text: "相手方と口頭で合意した事項、運用メモなど" },
        },
      },
      {
        type: "input",
        block_id: "notes",
        label: { type: "plain_text", text: isConsultationType ? "💬 相談内容・レビュー観点" : "💬 補足・参考資料" },
        optional: true,
        element: {
          type: "plain_text_input",
          action_id: "input",
          multiline: true,
          initial_value: existingValues.notes ?? "",
          placeholder: {
            type: "plain_text",
            text: isConsultationType
              ? "確認してほしい論点、レビューしてほしい観点、参考URLなど"
              : "注意点・既存契約との関連など",
          },
        },
      },
      {
        type: "input",
        block_id: "request_attachments",
        optional: true,
        label: { type: "plain_text", text: "📎 添付ファイル（任意）" },
        element: {
          type: "file_input",
          action_id: "file_input",
          max_files: 10,
        },
      },
    ],
  };
}

function contractTypeOption(contractType: string) {
  const found = CONTRACT_TYPES.find((item) => item.value === contractType) ?? CONTRACT_TYPES[0];
  return {
    text: { type: "plain_text" as const, text: found.text },
    value: found.value,
  };
}

function primaryContractTypeOption(contractType?: string) {
  const found = PRIMARY_REQUEST_TYPES.find((item) => item.value === contractType) ?? PRIMARY_REQUEST_TYPES[0];
  return {
    text: { type: "plain_text" as const, text: found.text },
    value: found.value,
  };
}

function requestModeOption(value: "new_request" | "append_request" | string) {
  return value === "append_request"
    ? { text: { type: "plain_text" as const, text: "既存課題に追記" }, value: "append_request" }
    : { text: { type: "plain_text" as const, text: "新規依頼を出す" }, value: "new_request" };
}

function driveFolderOption(driveFolderKey?: string) {
  const options = listDriveFolderOptions();
  const found = options.find((item) => item.key === driveFolderKey)
    ?? options.find((item) => item.key === getDefaultDriveFolderKey())
    ?? options[0];
  return {
    text: { type: "plain_text" as const, text: found.label },
    value: found.key,
  };
}

export function buildTextareaBlock(id: string, label: string, existingValues: ModalValueMap, placeholder: string) {
  return {
    type: "input",
    block_id: id,
    optional: true,
    label: { type: "plain_text", text: label },
    element: {
      type: "plain_text_input",
      action_id: "input",
      multiline: true,
      initial_value: existingValues[id] ?? "",
      placeholder: { type: "plain_text", text: placeholder },
    },
  };
}

export function extractModalValues(values: Record<string, any>): ModalValueMap {
  const getText = (blockId: string, actionId = "input") => values?.[blockId]?.[actionId]?.value ?? "";
  const getSelect = (blockId: string, actionId = "contract_type_select") =>
    values?.[blockId]?.[actionId]?.selected_option?.value ?? "";
  const getDate = (blockId: string, actionId = "datepicker") => values?.[blockId]?.[actionId]?.selected_date ?? "";

  return {
    contract_type: getSelect("contract_type"),
    drive_folder_key: getSelect("drive_folder_key", "drive_folder_select"),
    registration_number: getText("registration_number"),
    counterparty: getText("counterparty"),
    summary: getText("summary"),
    contract_date: getDate("contract_date"),
    nda_purpose: getText("nda_purpose"),
    contract_period: getText("contract_period"),
    confidentiality_period: getText("confidentiality_period"),
    jurisdiction: getText("jurisdiction"),
    original_work: getText("original_work"),
    original_author: getText("original_author"),
    credit_name: getText("credit_name"),
    succession_memorandum_date: getText("succession_memorandum_date"),
    license_type_name: getText("license_type_name"),
    license_bundle_mode: getSelect("license_bundle_mode", "license_bundle_mode_select"),
    outsourcing_bundle_mode: getSelect("outsourcing_bundle_mode", "outsourcing_bundle_mode_select"),
    delivery_item_no: getSelect("delivery_item_no", "delivery_item_no_select"),
    license_start: getDate("license_start"),
    territory: getText("territory"),
    deal_structure: getText("deal_structure"),
    change_mode: getText("change_mode"),
    base_agreement_key: getText("base_agreement_key"),
    effective_date: getDate("effective_date"),
    license_scope: getText("license_scope"),
    ip_product_scope: getText("ip_product_scope"),
    exclusivity: getText("exclusivity"),
    revenue_model: getText("revenue_model"),
    royalty_terms: getText("royalty_terms"),
    sublicense_allowed: getText("sublicense_allowed"),
    title_transfer_model: getText("title_transfer_model"),
    inventory_selloff: getText("inventory_selloff"),
    amendment_clauses: getText("amendment_clauses"),
    special_notes: getText("special_notes"),
    project_title: getText("project_title"),
    order_summary: getText("order_summary"),
    parent_issue_key: getText("parent_issue_key"),
    item_no: getText("item_no"),
    delivery_note: getText("delivery_note"),
    delivered_amount: getText("delivered_amount"),
    license_issue_key: getText("license_issue_key"),
    product_name: getText("product_name"),
    edition: getText("edition"),
    completion_date: getDate("completion_date"),
    quantity: getText("quantity"),
    msrp: getText("msrp"),
    sample_quantity: getText("sample_quantity"),
    report_period_start: getDate("report_period_start"),
    report_period_end: getDate("report_period_end"),
    sales_amount: getText("sales_amount"),
    received_amount: getText("received_amount"),
    sales_quantity: getText("sales_quantity"),
    deadline: getDate("deadline"),
    counterparty_address: getText("counterparty_address"),
    counterparty_representative: getText("counterparty_representative"),
    remarks: getText("remarks"),
    notes: getText("notes"),
  };
}
