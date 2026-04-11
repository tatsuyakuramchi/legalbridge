/**
 * documents/conditionBasedGenerator.ts
 * 支払条件・検収条件をもとに検収書と支払通知書を同時生成する
 *
 * generator.ts の上位レイヤー。
 * Backlog Webhookから呼ばれる想定。
 */

import Handlebars from "handlebars";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { google } from "googleapis";
import { resolveConditions, RawConditionFields } from "./conditions";

export interface GeneratedPair {
  inspectionCert: GeneratedFile;
  paymentNotice: GeneratedFile;
}

export interface GeneratedFile {
  filename: string;
  localPath: string;
  driveUrl?: string;
}

const TEMPLATE_DIR = path.resolve(__dirname, "../../templates");
const TMP_DIR = path.resolve(__dirname, "../../tmp");

/**
 * Backlogフィールドのデータから検収書と支払通知書を同時生成する
 */
export async function generateConditionBasedDocuments(
  raw: RawConditionFields
): Promise<GeneratedPair> {
  // 日付・金額を計算
  const resolved = resolveConditions(raw);

  console.log(`[Generator] 条件計算完了:
    検収期限: ${resolved.inspectionDeadline}
    支払条件: ${resolved.paymentConditionSummary}
    締め日: ${resolved.closingDate}
    支払期日: ${resolved.paymentDueDate}
    合計金額: ¥${resolved.totalAmountStr}`);

  fs.mkdirSync(TMP_DIR, { recursive: true });

  const ts = timestamp();

  // 検収書を生成
  const inspectionCert = await renderAndSave(
    "inspection_cert.html",
    resolved as unknown as Record<string, unknown>,
    `${raw.issueKey}_検収書_${ts}`
  );

  // 支払通知書を生成
  const paymentNotice = await renderAndSave(
    "payment_notice.html",
    resolved as unknown as Record<string, unknown>,
    `${raw.issueKey}_支払通知書_${ts}`
  );

  return { inspectionCert, paymentNotice };
}

// ================================================================
// 内部処理
// ================================================================

async function renderAndSave(
  templateFile: string,
  variables: Record<string, unknown>,
  basename: string
): Promise<GeneratedFile> {
  const templatePath = path.join(TEMPLATE_DIR, templateFile);
  const source = fs.readFileSync(templatePath, "utf-8");
  const template = Handlebars.compile(source);
  const html = template(variables);

  const htmlPath = path.join(TMP_DIR, `${basename}.html`);
  const pdfPath = path.join(TMP_DIR, `${basename}.pdf`);
  fs.writeFileSync(htmlPath, html, "utf-8");

  let finalPath = htmlPath;
  let filename = `${basename}.html`;

  // WeasyPrint でPDF化
  if (isWeasyPrintAvailable()) {
    try {
      execSync(`weasyprint "${htmlPath}" "${pdfPath}"`, { timeout: 30_000 });
      finalPath = pdfPath;
      filename = `${basename}.pdf`;
      fs.unlinkSync(htmlPath); // HTML中間ファイルを削除
      console.log(`[Generator] PDF生成完了: ${filename}`);
    } catch (e) {
      console.warn(`[Generator] WeasyPrint失敗、HTMLで続行: ${e}`);
    }
  }

  const result: GeneratedFile = { filename, localPath: finalPath };

  // Google Drive にアップロード
  try {
    result.driveUrl = await uploadToDrive(filename, finalPath);
    console.log(`[Generator] Driveアップロード完了: ${result.driveUrl}`);
  } catch (e) {
    console.error(`[Generator] Driveアップロード失敗: ${e}`);
  }

  return result;
}

async function uploadToDrive(filename: string, filePath: string): Promise<string> {
  const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH;
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!keyPath || !folderId) throw new Error("Drive環境変数未設定");

  const auth = new google.auth.GoogleAuth({
    keyFile: keyPath,
    scopes: ["https://www.googleapis.com/auth/drive.file"],
  });
  const drive = google.drive({ version: "v3", auth });
  const mimeType = filename.endsWith(".pdf") ? "application/pdf" : "text/html";

  const res = await drive.files.create({
    requestBody: { name: filename, parents: [folderId] },
    media: { mimeType, body: fs.createReadStream(filePath) },
    fields: "id, webViewLink",
  });

  await drive.permissions.create({
    fileId: res.data.id!,
    requestBody: { type: "anyone", role: "reader" },
  });

  return res.data.webViewLink ?? `https://drive.google.com/file/d/${res.data.id}`;
}

function isWeasyPrintAvailable(): boolean {
  try { execSync("weasyprint --version", { stdio: "pipe" }); return true; }
  catch { return false; }
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}
