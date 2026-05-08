/**
 * documents/generator.ts
 * 法務文書の生成・Google Drive保管を担当
 *
 * 現プロトタイプのスコープ:
 * - Handlebars でHTMLをレンダリング
 * - WeasyPrint でPDF化（ローカルにインストール要）
 * - Google Drive API でアップロード
 *
 * WeasyPrintが未インストールの環境ではHTMLファイルのみ生成する
 */

import Handlebars from "handlebars";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { google } from "googleapis";

// ---- 型定義 ----

export type DocumentType =
  | "purchase_order"    // 発注書
  | "payment_notice"    // 支払通知書
  | "inspection_cert"  // 検収書
  | "nda";             // 秘密保持契約書（NDA）

export interface DocumentData {
  type: DocumentType;
  issueKey: string;    // Backlog課題キー（ファイル名に使用）
  variables: Record<string, string | number>;
}

export interface GeneratedDocument {
  filename: string;
  localPath: string;
  driveUrl?: string;   // Drive保管後にセット
}

// ---- テンプレートパス解決 ----

const TEMPLATE_DIR = path.resolve(__dirname, "../../templates");

const TEMPLATE_MAP: Record<DocumentType, string> = {
  purchase_order: "purchase_order.html",
  payment_notice: "payment_notice.html",
  inspection_cert: "inspection_cert.html",
  nda: "nda.html",
};

// ---- メイン生成関数 ----

/**
 * 文書を生成してGoogle Driveに保管する
 * @returns GeneratedDocument（driveUrlはDrive保管成功時のみセット）
 */
export async function generateDocument(doc: DocumentData): Promise<GeneratedDocument> {
  const templateFile = TEMPLATE_MAP[doc.type];
  const templatePath = path.join(TEMPLATE_DIR, templateFile);

  // テンプレートファイルが存在するか確認（プロトタイプではフォールバックあり）
  let html: string;
  if (fs.existsSync(templatePath)) {
    const source = fs.readFileSync(templatePath, "utf-8");
    const template = Handlebars.compile(source);
    html = template(doc.variables);
  } else {
    // テンプレートが未整備の場合のフォールバック
    html = buildFallbackHtml(doc);
    console.warn(`[Documents] テンプレート未整備: ${templateFile} - フォールバックHTMLを使用`);
  }

  // 一時ディレクトリにHTML保存
  const tmpDir = path.resolve(__dirname, "../../tmp");
  fs.mkdirSync(tmpDir, { recursive: true });

  const basename = `${doc.issueKey}_${doc.type}_${timestamp()}`;
  const htmlPath = path.join(tmpDir, `${basename}.html`);
  const pdfPath = path.join(tmpDir, `${basename}.pdf`);

  fs.writeFileSync(htmlPath, html, "utf-8");

  // WeasyPrint でPDF生成（インストール済みの場合のみ）
  let finalPath = htmlPath;
  let filename = `${basename}.html`;

  if (isWeasyPrintAvailable()) {
    try {
      execSync(`weasyprint "${htmlPath}" "${pdfPath}"`, { timeout: 30_000 });
      finalPath = pdfPath;
      filename = `${basename}.pdf`;
      console.log(`[Documents] PDF生成完了: ${pdfPath}`);
    } catch (e) {
      console.error("[Documents] WeasyPrint失敗 - HTMLのままDriveにアップロードします", e);
    }
  } else {
    console.log("[Documents] WeasyPrint未インストール - HTMLのままアップロードします");
  }

  const result: GeneratedDocument = { filename, localPath: finalPath };

  // Google Drive にアップロード
  try {
    result.driveUrl = await uploadToDrive(filename, finalPath);
    console.log(`[Documents] Driveアップロード完了: ${result.driveUrl}`);
  } catch (e) {
    console.error("[Documents] Driveアップロード失敗（ローカルファイルは保持）", e);
  }

  return result;
}

// ---- Google Drive アップロード ----

async function uploadToDrive(filename: string, filePath: string): Promise<string> {
  const keyPath = String(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH ?? "").trim();
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;

  if (!folderId) {
    throw new Error("Google Drive環境変数が未設定です（GOOGLE_DRIVE_FOLDER_ID）");
  }

  const keyFile = keyPath && fs.existsSync(keyPath) ? keyPath : "";
  const auth = new google.auth.GoogleAuth({
    ...(keyFile ? { keyFile } : {}),
    scopes: ["https://www.googleapis.com/auth/drive.file"],
  });

  const drive = google.drive({ version: "v3", auth });

  const mimeType = filename.endsWith(".pdf") ? "application/pdf" : "text/html";

  const res = await drive.files.create({
    requestBody: {
      name: filename,
      parents: [folderId],
    },
    media: {
      mimeType,
      body: fs.createReadStream(filePath),
    },
    fields: "id, webViewLink",
  });

  // 閲覧権限を付与（社内共有の場合はdomainに変更）
  await drive.permissions.create({
    fileId: res.data.id!,
    requestBody: { type: "anyone", role: "reader" },
  });

  return res.data.webViewLink ?? `https://drive.google.com/file/d/${res.data.id}`;
}

// ---- ユーティリティ ----

function isWeasyPrintAvailable(): boolean {
  try {
    execSync("weasyprint --version", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

/** テンプレートファイル未整備時のフォールバックHTML */
function buildFallbackHtml(doc: DocumentData): string {
  const rows = Object.entries(doc.variables)
    .map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`)
    .join("\n");

  return `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8">
<title>${doc.type} - ${doc.issueKey}</title>
<style>
  body { font-family: "IPAGothic", sans-serif; margin: 40px; }
  h1 { border-bottom: 2px solid #000; padding-bottom: 8px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #ccc; padding: 8px 12px; text-align: left; }
  th { background: #f5f5f5; width: 200px; }
</style>
</head><body>
<h1>【${doc.type}】${doc.issueKey}</h1>
<p>生成日時: ${new Date().toLocaleString("ja-JP")}</p>
<table>${rows}</table>
<p style="color:gray;font-size:12px;">※ このドキュメントはフォールバックテンプレートで生成されました</p>
</body></html>`;
}
