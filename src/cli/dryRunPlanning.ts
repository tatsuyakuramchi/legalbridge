import dotenv from "dotenv";
dotenv.config();

import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { convertWorkbookSheetToCsv, listWorkbookSheetsFromBase64 } from "../orders/xlsxImport";
import { parseOrderCsv } from "../orders/csvImport";
import { renderTemplate } from "../documents/templateRenderer";
import { findStaffBySlackUserId, matchVendor } from "../db/repository";
import { getPaymentMethodLabel, normalizePaymentMethodCode } from "../payments/methods";

async function main() {
  const [, , xlsxPathArg, sheetNameArg, requesterSlackIdArg] = process.argv;
  if (!xlsxPathArg) {
    throw new Error("使い方: npm run dryrun:planning -- <xlsxファイルパス> [シート名] [SlackUserID]");
  }

  const xlsxPath = path.resolve(xlsxPathArg);
  if (!fs.existsSync(xlsxPath)) {
    throw new Error(`ファイルが見つかりません: ${xlsxPath}`);
  }

  const base64 = fs.readFileSync(xlsxPath).toString("base64");
  const sheets = listWorkbookSheetsFromBase64(base64);
  const sheetName = sheetNameArg || sheets[0]?.name;
  if (!sheetName) {
    throw new Error("利用可能なシートがありません。");
  }

  const { csvText } = convertWorkbookSheetToCsv({ base64, sheetName });
  const parsed = parseOrderCsv(csvText, {
    mode: "planning",
    sourceFileName: path.basename(xlsxPath),
  });

  if (parsed.mode !== "planning" || !parsed.planningContext) {
    throw new Error("企画発注書モードの解析に失敗しました。");
  }
  const planningContext = parsed.planningContext;

  const orderDate = new Date();
  const staff = requesterSlackIdArg ? await findStaffBySlackUserId(requesterSlackIdArg) : null;
  const outputDir = path.resolve(__dirname, "../../tmp/dryrun-planning");
  fs.mkdirSync(outputDir, { recursive: true });

  const renderedDocs: Array<{ vendorCode: string; htmlPath: string; pdfPath?: string }> = [];
  for (const group of planningContext.groups) {
    const groupItems = parsed.items.filter((item) => item.vendorCode === group.vendorCode);
    const vendor = await matchVendor({
      vendorCode: group.vendorCode,
      vendorName: group.vendorLookupValue,
    });

    const rendered = await renderTemplate({
      templateKey: "order_planning",
      uploadToDrive: false,
      outputBasename: `${safeBasename(planningContext.projectTitle || path.basename(xlsxPath, path.extname(xlsxPath)))}_${group.vendorCode}`,
      variables: {
        ORDER_NO: `DRYRUN-${group.vendorCode}`,
        ORDER_DATE_YEAR: String(orderDate.getFullYear()),
        ORDER_DATE_MONTH: String(orderDate.getMonth() + 1),
        ORDER_DATE_DAY: String(orderDate.getDate()),
        PROJECT_TITLE: planningContext.projectTitle || path.basename(xlsxPath, path.extname(xlsxPath)),
        VENDOR_NAME: vendor?.vendorName ?? group.vendorLookupValue ?? group.vendorCode,
        VENDOR_SUFFIX: vendor?.vendorSuffix ?? "御中",
        VENDOR_ADDRESS: vendor?.address ?? "",
        VENDOR_EMAIL: vendor?.email ?? "",
        VENDOR_CONTACT_NAME: vendor?.contactName ?? "",
        VENDOR_CONTACT_DEPARTMENT: vendor?.contactDepartment ?? "",
        PARTY_A_NAME: staff?.partyAName ?? "株式会社アークライト",
        PARTY_A_ADDRESS: staff?.partyAAddress ?? "〒101-0052 東京都千代田区神田小川町1-2 風雲堂ビル2階",
        PARTY_A_REP: staff?.partyARep ?? "代表取締役 青柳昌行",
        STAFF_DEPARTMENT: staff?.department ?? "",
        STAFF_NAME: staff?.staffName ?? "",
        STAFF_PHONE: staff?.phone ?? "",
        STAFF_EMAIL: staff?.email ?? "",
        BANK_INFO: vendor?.bankInfo ?? "",
        BANK_NAME: vendor?.bankName ?? "",
        BRANCH_NAME: vendor?.branchName ?? "",
        ACCOUNT_TYPE: vendor?.accountType ?? "",
        ACCOUNT_NUMBER: vendor?.accountNumber ?? "",
        ACCOUNT_HOLDER_KANA: vendor?.accountHolderKana ?? "",
        INVOICE_REGISTRATION_NUMBER: vendor?.invoiceRegistrationNumber ?? "",
        TRANSFER_FEE_PAYER: planningContext.transferFeePayer,
        PAYMENT_TERMS: group.paymentTermsLabel,
        MASTER_CONTRACT_REF: vendor?.masterContractRef ?? "",
        SPECIAL_TERMS: "",
        REMARKS: "",
        SHOW_SIGN_SECTION: false,
        ITEM_NAME: groupItems[0]?.desc ?? "",
        FIRST_DRAFT_DEADLINE: planningContext.firstDraftDeadlineLabel,
        FINAL_DEADLINE: group.finalDeadlineLabel,
        grandTotalExTax: groupItems.reduce((sum, item) => sum + item.amount, 0),
        items: groupItems.map((item) => ({
          category: item.category ?? "イラスト制作",
          item_name: item.desc,
          payment_method_display: getPaymentMethodLabel(normalizePaymentMethodCode(item.payMethod ?? "一括")),
          qty: item.qty ?? 1,
          unitPrice: item.unitPrice ?? item.amount,
          amount: item.amount,
          detailText: item.spec ?? "",
          payment_date: planningContext.paymentDateLabel,
          deliveryDateStr: planningContext.firstDraftDeadlineLabel,
          rightsLabel: planningContext.rightsLabel,
          transfer_fee: planningContext.transferFee,
        })),
      },
    });

    const finalPath = path.join(outputDir, path.basename(rendered.localPath));
    fs.copyFileSync(rendered.localPath, finalPath);
    renderedDocs.push({
      vendorCode: group.vendorCode,
      htmlPath: finalPath,
      pdfPath: convertHtmlToPdf(finalPath),
    });
  }

  const manifestPath = path.join(outputDir, `${safeBasename(planningContext.projectTitle || "dryrun")}_manifest.json`);
  fs.writeFileSync(manifestPath, JSON.stringify({
    source: xlsxPath,
    sheetName,
    generatedAt: new Date().toISOString(),
    count: renderedDocs.length,
    renderedDocs,
  }, null, 2), "utf-8");

  console.log(JSON.stringify({
    ok: true,
    sheetName,
    generatedCount: renderedDocs.length,
    outputDir,
    manifestPath,
    sample: renderedDocs.slice(0, 5),
  }, null, 2));
}

function safeBasename(value: string): string {
  return value.replace(/[/\\:*?"<>|]/g, "_");
}

function convertHtmlToPdf(htmlPath: string): string | undefined {
  if (!htmlPath.toLowerCase().endsWith(".html")) {
    return htmlPath;
  }

  const pythonPath = resolvePythonPath();
  if (!pythonPath) {
    return undefined;
  }

  const pdfPath = htmlPath.replace(/\.html$/i, ".pdf");
  try {
    execFileSync(pythonPath, ["-m", "weasyprint", htmlPath, pdfPath], {
      stdio: "pipe",
      timeout: 120_000,
    });
    return pdfPath;
  } catch (error) {
    console.warn(`[DryRun] PDF変換失敗: ${htmlPath} -> ${pdfPath}: ${error}`);
    return undefined;
  }
}

function resolvePythonPath(): string | null {
  const candidates = [
    process.env.PYTHON_WEASYPRINT_PATH,
    path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Python", "Python312", "python.exe"),
    "python",
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ["--version"], { stdio: "pipe", timeout: 10_000 });
      return candidate;
    } catch {
      // continue
    }
  }
  return null;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
