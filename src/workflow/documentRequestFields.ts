import { DocumentRequestType } from "./documentRequestConfig";

export interface DocumentRequestFieldDefinition {
  id: string;
  label: string;
  required?: boolean;
  multiline?: boolean;
  placeholder?: string;
  helper?: string;
}

export interface DocumentRequestFieldGroup {
  title: string;
  description?: string;
  fields: DocumentRequestFieldDefinition[];
}

const COMMON_GROUPS: DocumentRequestFieldGroup[] = [
  {
    title: "共通項目",
    description: "Slack受付で最初に聞く共通ヘッダです。住所や代表者などの詳細は DB / 管理UI 側で補完します。",
    fields: [
      {
        id: "registration_number",
        label: "登録番号",
        placeholder: "個人は執筆者登録番号 / 法人は国税の登録番号",
        helper: "必要な種別だけ Slack で入力し、不要な情報は DB / 管理UI 側で補完します。",
      },
      {
        id: "counterparty",
        label: "相手方名",
        placeholder: "株式会社サンプル",
        helper: "必要な種別だけ Slack で入力します。",
      },
      {
        id: "desired_due_date",
        label: "文書作成希望完了日",
        placeholder: "2026-04-15",
      },
      {
        id: "remarks",
        label: "備考",
        multiline: true,
        placeholder: "相手方と口頭で合意した事項、運用メモなど",
        helper: "相手方とこんな約束をした、など補足があれば入力してください。",
      },
    ],
  },
];

const FIELD_GROUPS: Record<DocumentRequestType, DocumentRequestFieldGroup[]> = {
  legal_consultation: [
    {
      title: "法務相談",
      description: "レビュー依頼と相談を同じ入口で受け付けます。必要な情報だけ入力してください。",
      fields: [
        {
          id: "counterparty",
          label: "相手方・相談先",
          placeholder: "株式会社サンプル / 社内案件なら空欄でも可",
          helper: "文書レビューの場合は相手方や相談先を入力してください。未定なら空欄でも構いません。",
        },
        {
          id: "remarks",
          label: "相談背景・補足",
          multiline: true,
          placeholder: "経緯、懸念点、期限感など",
        },
        {
          id: "notes",
          label: "レビュー観点・相談内容",
          multiline: true,
          placeholder: "確認してほしい論点、レビューしてほしいポイント、参考URLなど",
        },
      ],
    },
  ],
  nda: [
    ...COMMON_GROUPS,
    {
      title: "NDA固有項目",
      fields: [
        { id: "contract_date", label: "契約日", required: true, placeholder: "2026-04-01" },
        { id: "contract_period", label: "契約期間", required: true, placeholder: "1年" },
      ],
    },
  ],
  outsourcing: [
    ...COMMON_GROUPS,
    {
      title: "業務委託基本契約固有項目",
      fields: [
        { id: "contract_date", label: "契約日", required: true, placeholder: "2026-04-01" },
        { id: "contract_period", label: "契約期間", required: true, placeholder: "1年" },
      ],
    },
  ],
  license: [
    ...COMMON_GROUPS,
    {
      title: "ライセンス基本情報",
      fields: [
        { id: "contract_date", label: "契約日", required: true, placeholder: "2026-04-01" },
        { id: "contract_period", label: "契約期間", required: true, placeholder: "1年" },
      ],
    },
  ],
  license_schedule: [
    ...COMMON_GROUPS,
    {
      title: "基本条件",
      description: "個別利用許諾条件では、親ライセンス課題キーと開始日だけを Slack で受けます。Backlog は任意の補足欄とし、その他の条件は DB / 管理 UI 側で保持します。",
      fields: [
        { id: "license_issue_key", label: "親ライセンス課題キー", required: true, placeholder: "LEGAL-10" },
        { id: "license_start", label: "許諾開始日", required: true, placeholder: "2026-04-01", helper: "契約期間はマスタ契約前提のため、個別条件では開始日を管理します。" },
      ],
    },
  ],
  ip_overseas_master: [
    ...COMMON_GROUPS,
    {
      title: "海外IP契約（基本契約）",
      description: "Backlog には任意の補足として契約日と契約期間だけ残し、詳細条件は DB / 管理 UI 側で保持します。",
      fields: [
        { id: "contract_date", label: "契約日", required: true, placeholder: "2026-04-01" },
        { id: "contract_period", label: "契約期間", required: true, placeholder: "5 years" },
      ],
    },
  ],
  ip_overseas_amendment: [
    ...COMMON_GROUPS,
    {
      title: "海外IP契約（変更合意）",
      description: "Backlog には任意の補足として契約日と契約期間だけ残し、変更詳細は DB / 管理 UI 側で保持します。",
      fields: [
        { id: "contract_date", label: "変更合意日", required: true, placeholder: "2026-04-01" },
        { id: "contract_period", label: "契約期間", required: true, placeholder: "5 years" },
      ],
    },
  ],
  sales_buyer: [
    ...COMMON_GROUPS,
    {
      title: "売買契約（当社買手）",
      description: "Backlog には任意の補足として契約日と契約期間だけ残し、売買条件の詳細は DB / 管理 UI 側で保持します。",
      fields: [
        { id: "contract_date", label: "契約日", required: true, placeholder: "2026-04-01" },
        { id: "contract_period", label: "契約期間", required: true, placeholder: "1年" },
      ],
    },
  ],
  sales_seller_standard: [
    ...COMMON_GROUPS,
    {
      title: "売買契約（当社売手・標準）",
      description: "Backlog には任意の補足として契約日と契約期間だけ残し、売買条件の詳細は DB / 管理 UI 側で保持します。",
      fields: [
        { id: "contract_date", label: "契約日", required: true, placeholder: "2026-04-01" },
        { id: "contract_period", label: "契約期間", required: true, placeholder: "1年" },
      ],
    },
  ],
  sales_seller_credit: [
    ...COMMON_GROUPS,
    {
      title: "売買契約（当社売手・保証金掛け売り）",
      description: "Backlog には任意の補足として契約日と契約期間だけ残し、売買条件の詳細は DB / 管理 UI 側で保持します。",
      fields: [
        { id: "contract_date", label: "契約日", required: true, placeholder: "2026-04-01" },
        { id: "contract_period", label: "契約期間", required: true, placeholder: "1年" },
      ],
    },
  ],
  delivery_request: [
    {
      title: "納品リクエスト",
      description: "発注明細を指定して納品管理を始めるための後続申請です。金額や検収条件は起票後に補完できます。",
      fields: [
        { id: "parent_issue_key", label: "親課題キー", required: true, placeholder: "LEGAL-123" },
        { id: "item_no", label: "明細番号", required: true, placeholder: "1" },
        { id: "delivery_note", label: "納品備考", multiline: true, placeholder: "納品内容や差分を入力" },
      ],
    },
  ],
  royalty_calculation_manufacturing: [
    {
      title: "利用許諾料計算（製造ベース）",
      description: "ライセンス案件に紐づく製造実績の登録です。製造した時点で計算日が決まるパターンを想定しています。",
      fields: [
        { id: "license_issue_key", label: "紐付けライセンス課題キー", required: true, placeholder: "LEGAL-456" },
        { id: "product_name", label: "製品名", required: true, placeholder: "トレーディングカード第1弾" },
        { id: "completion_date", label: "製造完了日", required: true, placeholder: "2026-04-15", helper: "この日付を起点に支払期限や報告期限を計算します。" },
        { id: "quantity", label: "製造数量", required: true, placeholder: "10000", helper: "販売用の製造数量を入力してください。" },
        { id: "msrp", label: "MSRP", required: true, placeholder: "350", helper: "税抜の希望小売価格を入力してください。" },
        { id: "remarks", label: "備考", multiline: true, placeholder: "計算メモを入力" },
      ],
    },
  ],
  royalty_calculation_sales_report: [
    {
      title: "利用許諾料計算（売上報告ベース）",
      description: "ライセンス案件に紐づく売上報告の登録です。報告対象期間の終了時点で計算日が決まるパターンを想定しています。",
      fields: [
        { id: "license_issue_key", label: "紐付けライセンス課題キー", required: true, placeholder: "LEGAL-456" },
        { id: "product_name", label: "対象商品・報告単位名", required: true, placeholder: "ダブルナイン 日本語版" },
        { id: "report_period_end", label: "報告対象期間終了", required: true, placeholder: "2026-06-30", helper: "この期間終了日を起点に支払期限や報告期限を計算します。" },
        { id: "sales_amount", label: "売上高・正味売上高", required: true, placeholder: "3500000", helper: "売上ベースで計算する条件のときに入力します。" },
        { id: "remarks", label: "備考", multiline: true, placeholder: "報告メモを入力" },
      ],
    },
  ],
  purchase_order: [
    ...COMMON_GROUPS,
    {
      title: "発注書ヘッダ",
      description: "Backlog には任意の補足として発注日と案件名だけ残し、明細や支払条件の詳細は DB / 管理 UI 側で管理します。",
      fields: [
        { id: "contract_date", label: "発注日", required: true, placeholder: "2026-04-01" },
        { id: "project_title", label: "案件名", required: true, placeholder: "イラスト制作案件" },
      ],
    },
  ],
  planning_order: [
    ...COMMON_GROUPS,
    {
      title: "企画発注書ヘッダ",
      description: "Backlog には任意の補足として発注日と案件名だけ残し、参照情報や明細は DB / CSV 取込側で補完します。",
      fields: [
        { id: "contract_date", label: "発注日", required: true, placeholder: "2026-04-01" },
        { id: "project_title", label: "案件名", required: true, placeholder: "11月分企画発注" },
      ],
    },
  ],
  publishing_order: [
    ...COMMON_GROUPS,
    {
      title: "出版発注書ヘッダ",
      description: "Backlog には任意の補足として発注日と案件名だけ残し、進行詳細や明細は DB / CSV 取込側で管理します。",
      fields: [
        { id: "contract_date", label: "発注日", required: true, placeholder: "2026-04-01" },
        { id: "project_title", label: "案件名", required: true, placeholder: "2026年秋刊 書籍制作発注" },
      ],
    },
  ],
};

export function getDocumentRequestFieldGroups(type: DocumentRequestType): DocumentRequestFieldGroup[] {
  return FIELD_GROUPS[type] ?? [];
}

export function validateDocumentRequestValues(
  type: DocumentRequestType,
  values: Record<string, string | undefined>
): Array<{ fieldId: string; message: string }> {
  const errors: Array<{ fieldId: string; message: string }> = [];
  for (const group of getDocumentRequestFieldGroups(type)) {
    for (const field of group.fields) {
      if (!field.required) continue;
      const value = String(values[field.id] ?? "").trim();
      if (!value) {
        errors.push({ fieldId: field.id, message: `${field.label}は必須です。` });
      }
    }
  }
  return errors;
}
