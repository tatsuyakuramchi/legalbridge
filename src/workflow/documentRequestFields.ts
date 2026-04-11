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
    description: "Slack受付で最初に聞く共通ヘッダです。住所や代表者は Backlog / Local 側で補完します。",
    fields: [
      {
        id: "registration_number",
        label: "登録番号",
        placeholder: "個人は執筆者登録番号 / 法人は国税の登録番号",
        helper: "必要な種別だけ Slack で入力し、不要な種別は Backlog / Local 側で補完します。",
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
        { id: "nda_purpose", label: "秘密保持の目的", required: true, multiline: true, placeholder: "共同検討のため" },
        { id: "contract_period", label: "契約期間", required: true, placeholder: "1年" },
        { id: "confidentiality_period", label: "秘密保持期間", placeholder: "契約終了後3年" },
      ],
    },
  ],
  outsourcing: [
    ...COMMON_GROUPS,
    {
      title: "業務委託基本契約固有項目",
      fields: [
        { id: "contract_date", label: "契約日", required: true, placeholder: "2026-04-01" },
        { id: "notes", label: "業務概要・前提情報", multiline: true, placeholder: "委託業務の概要" },
      ],
    },
  ],
  license: [
    ...COMMON_GROUPS,
    {
      title: "ライセンス基本情報",
      fields: [
        { id: "contract_date", label: "契約日", placeholder: "2026-04-01" },
        { id: "original_work", label: "原著作物", required: true, placeholder: "作品名" },
      ],
    },
    {
      title: "契約補足",
      fields: [
        { id: "jurisdiction", label: "管轄裁判所", required: true, placeholder: "東京地方裁判所" },
      ],
    },
  ],
  license_schedule: [
    ...COMMON_GROUPS,
    {
      title: "基本条件",
      description: "個別利用許諾条件のヘッダ情報です。ライセンス基本契約がある場合は、その条件と矛盾しない範囲で入力します。詳細な金銭条件や素材情報は起票後に Backlog / Local 側で補完します。",
      fields: [
        { id: "license_issue_key", label: "親ライセンス課題キー", required: true, placeholder: "LEGAL-10" },
        { id: "license_type_name", label: "許諾区分", required: true, placeholder: "商品化許諾" },
        { id: "original_work", label: "対象作品・原著作物", required: true, placeholder: "作品名" },
        { id: "license_start", label: "許諾開始日", required: true, placeholder: "2026-04-01", helper: "契約期間はマスタ契約前提のため、個別条件では開始日を管理します。" },
        { id: "territory", label: "許諾地域・言語", placeholder: "日本国内 / 日本語" },
      ],
    },
  ],
  ip_overseas_master: [
    ...COMMON_GROUPS,
    {
      title: "契約ストラクチャー",
      description: "海外向けのIP取引について、ライセンスアウトかプロダクトアウトかをここで切り替えます。",
      fields: [
        { id: "contract_date", label: "契約日", required: true, placeholder: "2026-04-01" },
        { id: "deal_structure", label: "取引構造", required: true, placeholder: "license_out / product_out" },
        { id: "original_work", label: "原著作物・IP名", required: true, placeholder: "作品名 / IP名" },
        { id: "jurisdiction", label: "管轄裁判所", required: true, placeholder: "Tokyo District Court" },
        { id: "contract_period", label: "契約期間", placeholder: "5 years" },
      ],
    },
    {
      title: "事業条件",
      fields: [
        { id: "license_scope", label: "許諾対象 / 権利範囲", multiline: true, placeholder: "Licensed rights, media, channels" },
        { id: "ip_product_scope", label: "製品化対象 / 商品範囲", multiline: true, placeholder: "Board games, accessories, digital adaptations" },
        { id: "territory", label: "地域・言語", placeholder: "Worldwide / English" },
        { id: "exclusivity", label: "独占性", placeholder: "Exclusive / Non-exclusive / Sole" },
        { id: "revenue_model", label: "収益モデル", placeholder: "Royalty / Revenue share / Purchase and resale" },
        { id: "royalty_terms", label: "ロイヤリティ・対価条件", multiline: true, placeholder: "Rate, MG, report cycle, payment timing" },
      ],
    },
    {
      title: "運用条件",
      fields: [
        { id: "sublicense_allowed", label: "再許諾可否", placeholder: "Allowed with prior consent" },
        { id: "title_transfer_model", label: "権利帰属 / 成果物帰属", multiline: true, placeholder: "Ownership and derivative works treatment" },
        { id: "inventory_selloff", label: "終了後在庫処理", multiline: true, placeholder: "Sell-off period and disposal rules" },
        { id: "special_notes", label: "特記事項", multiline: true, placeholder: "Existing deal assumptions, transitional language" },
      ],
    },
    {
      title: "Schedule 1",
      description: "ライセンスアウト条件は、本文に入れたい内容を長文でまとめて入力します。",
      fields: [
        { id: "schedule_1_summary", label: "Schedule 1 Summary", multiline: true, placeholder: "Royalty rate, MG / advance, accounting period, payment / report due dates, first print run, target release date, complimentary copies, credit wording" },
        { id: "schedule_1_special_provisions", label: "Schedule 1 Special Provisions", multiline: true, placeholder: "Consumer law carve-out, VAT / GST, copyright registration, moral rights, mandatory distribution law, additional terms" },
      ],
    },
    {
      title: "Schedule 2",
      description: "プロダクトアウト条件も、供給条件・特則を長文でまとめて入力します。",
      fields: [
        { id: "schedule_2_summary", label: "Schedule 2 Summary", multiline: true, placeholder: "Price list, MPR, Incoterms, arrival point, advance / balance terms, currency" },
        { id: "schedule_2_special_provisions", label: "Schedule 2 Special Provisions", multiline: true, placeholder: "Import / customs, consumer product safety, distribution law protections, VAT / GST on supply, insurance, marketplaces, additional terms" },
      ],
    },
  ],
  ip_overseas_amendment: [
    ...COMMON_GROUPS,
    {
      title: "変更合意ヘッダ",
      description: "元契約を特定し、どの方向に構造変更するかを指定します。",
      fields: [
        { id: "contract_date", label: "変更合意日", required: true, placeholder: "2026-04-01" },
        { id: "base_agreement_key", label: "元契約課題キー", required: true, placeholder: "LEGAL-123" },
        { id: "effective_date", label: "変更効力発生日", required: true, placeholder: "2026-05-01" },
        { id: "change_mode", label: "変更モード", required: true, placeholder: "license_to_product / product_to_license / amendment" },
        { id: "deal_structure", label: "変更後の取引構造", required: true, placeholder: "license_out / product_out" },
      ],
    },
    {
      title: "変更対象",
      fields: [
        { id: "original_work", label: "原著作物・IP名", required: true, placeholder: "作品名 / IP名" },
        { id: "amendment_clauses", label: "変更対象条項", multiline: true, placeholder: "Clause 2, 4, 7 and schedule replacement" },
        { id: "license_scope", label: "変更後の許諾対象 / 権利範囲", multiline: true, placeholder: "Updated licensed rights" },
        { id: "ip_product_scope", label: "変更後の製品化対象 / 商品範囲", multiline: true, placeholder: "Updated product scope" },
        { id: "territory", label: "変更後の地域・言語", placeholder: "Worldwide / English" },
        { id: "revenue_model", label: "変更後の収益モデル", placeholder: "Royalty / Revenue share / Purchase and resale" },
        { id: "royalty_terms", label: "変更後の対価条件", multiline: true, placeholder: "Updated rates, MG, settlement terms" },
      ],
    },
    {
      title: "存続・補足",
      fields: [
        { id: "inventory_selloff", label: "在庫処理・移行措置", multiline: true, placeholder: "Sell-off and transition arrangement" },
        { id: "title_transfer_model", label: "権利帰属の扱い", multiline: true, placeholder: "Ownership after amendment" },
        { id: "special_notes", label: "特記事項", multiline: true, placeholder: "Existing clauses that remain unchanged" },
      ],
    },
    {
      title: "Schedule 1 変更後条件",
      fields: [
        { id: "schedule_1_summary", label: "Schedule 1 Summary", multiline: true, placeholder: "Updated royalty rate, MG / advance, accounting period, payment / report due dates, first print run, release date, complimentary copies, credit wording" },
        { id: "schedule_1_special_provisions", label: "Schedule 1 Special Provisions", multiline: true, placeholder: "Updated consumer law carve-out, VAT / GST, moral rights, distribution law, additional terms" },
      ],
    },
    {
      title: "Schedule 2 変更後条件",
      fields: [
        { id: "schedule_2_summary", label: "Schedule 2 Summary", multiline: true, placeholder: "Updated price list, MPR, Incoterms, arrival point, payment terms, currency" },
        { id: "schedule_2_special_provisions", label: "Schedule 2 Special Provisions", multiline: true, placeholder: "Updated import / customs, safety, distribution protections, VAT / GST, insurance, marketplaces, additional terms" },
      ],
    },
  ],
  sales_buyer: [
    ...COMMON_GROUPS,
    {
      title: "売買契約（当社買手）",
      description: "当社が仕入側となるケースです。契約本文に入れたい条件の要点を先にまとめます。",
      fields: [
        { id: "contract_date", label: "契約日", required: true, placeholder: "2026-04-01" },
        { id: "product_scope", label: "商品範囲", required: true, multiline: true, placeholder: "ボードゲーム関連商品一式" },
        { id: "payment_condition_summary", label: "支払条件概要", required: true, multiline: true, placeholder: "検収月末締め翌月末払い" },
        { id: "notes", label: "補足メモ", multiline: true, placeholder: "例外条件や運用メモがあれば入力" },
      ],
    },
  ],
  sales_seller_standard: [
    ...COMMON_GROUPS,
    {
      title: "売買契約（当社売手・標準）",
      description: "当社が売手となる標準的な掛け売り条件です。",
      fields: [
        { id: "contract_date", label: "契約日", required: true, placeholder: "2026-04-01" },
        { id: "product_scope", label: "商品範囲", required: true, multiline: true, placeholder: "トレーディングカード関連商品" },
        { id: "payment_condition_summary", label: "支払条件概要", required: true, multiline: true, placeholder: "月末締め翌月末払い" },
        { id: "notes", label: "補足メモ", multiline: true, placeholder: "例外条件や運用メモがあれば入力" },
      ],
    },
  ],
  sales_seller_credit: [
    ...COMMON_GROUPS,
    {
      title: "売買契約（当社売手・保証金掛け売り）",
      description: "保証金の取り決めがある売買契約です。保証金関連の条件がわかるように要約します。",
      fields: [
        { id: "contract_date", label: "契約日", required: true, placeholder: "2026-04-01" },
        { id: "product_scope", label: "商品範囲", required: true, multiline: true, placeholder: "ボードゲーム関連商品" },
        { id: "payment_condition_summary", label: "支払条件概要", required: true, multiline: true, placeholder: "月末締め翌月20日払い" },
        { id: "security_deposit_amount", label: "保証金額", required: true, placeholder: "300000" },
        { id: "deposit_replenish_days", label: "保証金補充期限", required: true, placeholder: "不足通知から5営業日以内" },
        { id: "notes", label: "補足メモ", multiline: true, placeholder: "例外条件や運用メモがあれば入力" },
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
      description: "明細は管理UIまたはCSV取込で管理します。",
      fields: [
        { id: "project_title", label: "案件名", required: true, placeholder: "イラスト制作案件" },
        {
          id: "order_summary",
          label: "発注概要",
          multiline: true,
          placeholder: "納期、支払日、仕様詳細等を入力してください。",
          helper: "納期、支払日、仕様詳細等を入力してください。決め打ちできない内容も含めて自由に記載できます。",
        },
      ],
    },
  ],
  planning_order: [
    ...COMMON_GROUPS,
    {
      title: "企画発注書ヘッダ",
      description: "案件名のみ Slack で受け、参照情報や明細は XLSX/CSV 取込や Backlog 側で補完します。",
      fields: [
        { id: "project_title", label: "案件名", required: true, placeholder: "11月分企画発注" },
      ],
    },
  ],
  publishing_order: [
    ...COMMON_GROUPS,
    {
      title: "出版発注書ヘッダ",
      description: "書誌進行や制作進行を前提にした出版向け発注です。明細は CSV 取込で管理します。",
      fields: [
        { id: "project_title", label: "案件名", required: true, placeholder: "2026年秋刊 書籍制作発注" },
        { id: "master_contract_ref", label: "マスター契約参照", placeholder: "PUB-MC-001" },
        {
          id: "order_summary",
          label: "進行概要",
          multiline: true,
          placeholder: "初校締切、再校締切、校了予定、支払予定などを要約",
          helper: "詳細な納期や検収日は CSV / Backlog 子課題で管理し、ここでは全体概要を入力します。",
        },
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
