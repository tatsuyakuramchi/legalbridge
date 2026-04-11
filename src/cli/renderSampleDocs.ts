import dotenv from "dotenv";
dotenv.config();

import fs from "fs";
import path from "path";
import { renderTemplate } from "../documents/templateRenderer";

type RenderResultSummary = {
  key: string;
  filename: string;
  localPath: string;
  copiedPath: string;
  isPdf: boolean;
};

const OUTPUT_DIR = path.resolve(__dirname, "../../tmp/sample-docs");

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const commonVendor = {
    VENDOR_NAME: "株式会社サンプルパートナーズ",
    VENDOR_SUFFIX: "御中",
    VENDOR_ADDRESS: "東京都港区芝公園1-2-3 サンプルビル5F",
    VENDOR_EMAIL: "info@sample-partners.example",
    VENDOR_CONTACT_NAME: "山田 花子",
    VENDOR_CONTACT_DEPARTMENT: "制作管理部",
    VENDOR_REPRESENTATIVE: "代表取締役 山田 花子",
    VENDOR_REPRESENTATIVE_SAMA: "代表取締役 山田 花子 様",
    INVOICE_REGISTRATION_NUMBER: "T1234567890123",
    BANK_NAME: "みずほ銀行",
    BRANCH_NAME: "神田支店",
    ACCOUNT_TYPE: "普通",
    ACCOUNT_NUMBER: "1234567",
    ACCOUNT_HOLDER_KANA: "カ)サンプルパートナーズ",
  };

  const results: RenderResultSummary[] = [];

  const order = await renderTemplate({
    templateKey: "order",
    uploadToDrive: false,
    outputBasename: "SAMPLE_発注書_代表者入り",
    variables: {
      ...commonVendor,
      ORDER_NO: "PO-SAMPLE-001",
      ORDER_DATE_YEAR: "2026",
      ORDER_DATE_MONTH: "4",
      ORDER_DATE_DAY: "10",
      PROJECT_TITLE: "新作ボードゲーム用アート制作",
      PARTY_A_NAME: "株式会社アークライト",
      PARTY_A_ADDRESS: "〒101-0052 東京都千代田区神田小川町1-2 風雲堂ビル2階",
      PARTY_A_REP: "代表取締役 青柳昌行",
      STAFF_DEPARTMENT: "法務部",
      STAFF_NAME: "倉持達也",
      STAFF_PHONE: "03-1234-5678",
      STAFF_EMAIL: "legal@arclight.example",
      summaryDeliveryDate: "2026年5月20日",
      summaryPaymentTerms: "2026年6月20日払い",
      PAYMENT_TERMS: "2026年6月20日払い",
      grandTotalExTax: 180000,
      MASTER_CONTRACT_REF: "LEGAL-100",
      TRANSFER_FEE_PAYER: "甲負担",
      SPECIAL_TERMS: "修正は2回まで無償対応。",
      REMARKS: "成果物データは PSD と PNG を納品。",
      REMARKS_FIXED: "発注条件は別紙のとおり。",
      REMARKS_FREE: "納期厳守でお願いします。",
      SHOW_ORDER_SIGN_SECTION: true,
      SHOW_SIGN_SECTION: true,
      ACCEPT_METHOD: "メール承諾",
      ACCEPT_REPLY_DUE_DATE: "2026-04-17",
      ACCEPT_BY_PERFORMANCE: false,
      VENDOR_ACCEPT_DATE: "",
      items: [
        {
          category: "イラスト制作",
          item_name: "キャラクターイラスト 3点",
          payment_method_display: "一括",
          qty: 3,
          unitPrice: 60000,
          amount: 180000,
          detailText: "A4 / 350dpi / 背景透過PNG納品",
        },
      ],
    },
  });
  results.push(copyResult("order", order));

  const planning = await renderTemplate({
    templateKey: "order_planning",
    uploadToDrive: false,
    outputBasename: "SAMPLE_企画発注書_代表者入り",
    variables: {
      ...commonVendor,
      ORDER_NO: "PLAN-SAMPLE-001",
      ORDER_DATE_YEAR: "2026",
      ORDER_DATE_MONTH: "4",
      ORDER_DATE_DAY: "10",
      PROJECT_TITLE: "出版進行スケジュール一括発注",
      PARTY_A_NAME: "株式会社アークライト",
      PARTY_A_ADDRESS: "〒101-0052 東京都千代田区神田小川町1-2 風雲堂ビル2階",
      PARTY_A_REP: "代表取締役 青柳昌行",
      STAFF_DEPARTMENT: "商品部",
      STAFF_NAME: "佐藤一郎",
      STAFF_PHONE: "03-2222-3333",
      STAFF_EMAIL: "prd@arclight.example",
      ITEM_NAME: "書籍本文DTP・校了対応",
      PAYMENT_TERMS: "2026年6月20日払い",
      FIRST_DRAFT_DEADLINE: "2026年4月30日",
      FINAL_DEADLINE: "2026年5月20日",
      MASTER_CONTRACT_REF: "LEGAL-200",
      SPECIAL_TERMS: "初校・再校の修正費を含む。",
      REMARKS: "奥付データは別送。",
      BANK_INFO: "みずほ銀行 神田支店 普通 1234567 カ)サンプルパートナーズ",
      TRANSFER_FEE_PAYER: "甲負担",
      ACCEPT_METHOD: "メール承諾",
      ACCEPT_REPLY_DUE_DATE: "2026-04-17",
    },
  });
  results.push(copyResult("order_planning", planning));

  const inspection = await renderTemplate({
    templateKey: "inspection",
    uploadToDrive: false,
    outputBasename: "SAMPLE_検収書_代表者入り",
    variables: {
      delivery_id: "LEGAL-500-1",
      vendor_name: "株式会社サンプルパートナーズ",
      vendor_representative: "代表取締役 山田 花子",
      vendor_representative_sama: "代表取締役 山田 花子 様",
      vendor_invoice_num: "T1234567890123",
      order_no: "PO-SAMPLE-001",
      contract_no: "LEGAL-100",
      project_name: "新作ボードゲーム用アート制作",
      items: [
        {
          inspection_date: "2026-05-21",
          name: "キャラクターイラスト 3点",
          order_no: "PO-SAMPLE-001",
          spec: "A4 / 350dpi / 背景透過PNG納品",
          no: "①1",
          thisTimeQuantity: 1,
          amount_ex_tax: 180000,
          hasAmountChange: false,
          originalAmount: 0,
          newAmount: 0,
          amountChangeReason: "",
          hasRevision: false,
          revisionDetail: "",
          isCompleted: true,
          partial_number: null,
          total_partials: null,
          is_final_delivery: true,
          milestone_name: "",
          delivery_url: "",
          notes: "データ確認済み",
        },
      ],
      totalExTax: 180000,
      totalIncTax: 198000,
      approver_name: "倉持達也",
      approver_department: "法務部",
      reviewer_name: "佐藤一郎",
      reviewer_department: "商品部",
      person_name: "倉持達也",
      person_department: "法務部",
      approval_date: "2026-05-21",
      approval_comments: "",
      deliveryTypeLabel: "全部納品",
      business_description: "キャラクターイラスト制作",
    },
  });
  results.push(copyResult("inspection", inspection));

  const paymentNotice = await renderTemplate({
    templateKey: "payment_notice",
    uploadToDrive: false,
    outputBasename: "SAMPLE_支払通知書_代表者入り",
    variables: {
      notice_id: "PAY-SAMPLE-001",
      notice_date: "2026-05-21",
      vendor_name: "株式会社サンプルパートナーズ",
      vendor_representative: "代表取締役 山田 花子",
      vendor_representative_sama: "代表取締役 山田 花子 様",
      vendorSuffix: "御中",
      vendor_invoice_num: "T1234567890123",
      SENDER_NAME: "株式会社アークライト",
      INVOICE_REGISTRATION_NUMBER: "T0000000000000",
      SENDER_ZIP: "101-0052",
      SENDER_ADDRESS: "東京都千代田区神田小川町1-2 風雲堂ビル2階",
      SENDER_DEPT: "法務部",
      STAFF_NAME: "倉持達也",
      totalWithTax: 198000,
      expenseAmount: null,
      withholdingTax: null,
      paymentAmount: 198000,
      showWithholdingNote: false,
      withholdingRateLabel: "",
      items: [
        {
          order_no: "PO-SAMPLE-001",
          name: "キャラクターイラスト 3点",
          detail: "A4 / 350dpi / 背景透過PNG納品",
          amount: 198000,
        },
      ],
      payment_due_date: "2026-06-20",
      BANK_NAME: "みずほ銀行",
      BRANCH_NAME: "神田支店",
      ACCOUNT_TYPE: "普通",
      ACCOUNT_NUMBER: "1234567",
      BANK_ACCOUNT_NAME: "カ)サンプルパートナーズ",
    },
  });
  results.push(copyResult("payment_notice", paymentNotice));

  const royalty = await renderTemplate({
    templateKey: "royalty_report",
    uploadToDrive: false,
    outputBasename: "SAMPLE_利用許諾料計算書_代表者入り",
    variables: {
      NOTICE_ID: "ROYALTY-SAMPLE-001",
      ISSUE_DATE: "2026-06-30",
      VENDOR_NAME: "株式会社サンプルライセンス",
      VENDOR_REPRESENTATIVE: "代表取締役 田中 次郎",
      VENDOR_REPRESENTATIVE_SAMA: "代表取締役 田中 次郎 様",
      VENDOR_INVOICE_NUM: "T9876543210987",
      ORDER_NO: "LEGAL-ROYALTY-001",
      items: [
        {
          date: "2026-06-30",
          name: "新作タイトル初回製造分",
          period_text: "2026年6月分",
          detail: "税込売上ベース精算",
          order_no: "MFG-001",
          qty: 3000,
          rate: "8%",
          amount: 240000,
          deduction: 0,
          deduction_note: "",
        },
      ],
      TOTAL_NONTAX: 240000,
      TOTAL_NET: 240000,
    },
  });
  results.push(copyResult("royalty_report", royalty));

  const manifestPath = path.join(OUTPUT_DIR, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    count: results.length,
    results,
  }, null, 2), "utf-8");

  console.log(JSON.stringify({
    ok: true,
    outputDir: OUTPUT_DIR,
    manifestPath,
    results,
  }, null, 2));
}

function copyResult(key: string, rendered: { filename: string; localPath: string }): RenderResultSummary {
  const targetPath = path.join(OUTPUT_DIR, path.basename(rendered.localPath));
  fs.copyFileSync(rendered.localPath, targetPath);
  return {
    key,
    filename: rendered.filename,
    localPath: rendered.localPath,
    copiedPath: targetPath,
    isPdf: targetPath.toLowerCase().endsWith(".pdf"),
  };
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
