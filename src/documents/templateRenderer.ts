/**
 * src/documents/templateRenderer.ts
 * 全テンプレートに対応した汎用レンダラー
 *
 * - Handlebarsでレンダリング
 * - ARCLIGHT_DEFAULTSを自動注入
 * - formatCurrency / formatDate ヘルパーを登録
 * - WeasyPrint → PDF化 → Google Drive保管
 */

import Handlebars from "handlebars";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { ARCLIGHT_DEFAULTS, TEMPLATE_MAP, TemplateKey } from "./templateRegistry";
import { tryUploadToDrive, tryUploadToDriveFolder } from "./fileStorage";

// ================================================================
// Handlebarsヘルパー登録
// ================================================================

Handlebars.registerHelper("formatCurrency", (value: unknown) => {
  const n = typeof value === "number" ? value : parseInt(String(value || "0").replace(/[,，]/g, ""), 10);
  return isNaN(n) ? "0" : n.toLocaleString("ja-JP");
});

Handlebars.registerHelper("formatDate", (value: unknown) => {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(String(value));
  return isNaN(d.getTime()) ? String(value) : d.toLocaleDateString("ja-JP");
});

Handlebars.registerHelper("formatDateTime", (value: unknown) => {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(String(value));
  return isNaN(d.getTime()) ? String(value) : d.toLocaleString("ja-JP");
});

Handlebars.registerHelper("add", (a: number, b: number) => a + b);
Handlebars.registerHelper("eq", (a: unknown, b: unknown) => a === b);
Handlebars.registerHelper("if_eq", function(this: unknown, a: unknown, b: unknown, options: Handlebars.HelperOptions) {
  return a === b ? options.fn(this) : options.inverse(this);
});
Handlebars.registerHelper("lb_map", (key: unknown, value: unknown) => {
  const keyText = escapeHtmlText(String(key ?? ""));
  const valueText = escapeHtmlText(value == null ? "" : String(value));
  return new Handlebars.SafeString(
    `<span data-lb-map-key="${keyText}" class="lb-map-token">${valueText}</span>`
  );
});

// ================================================================
// 型定義
// ================================================================

export interface RenderOptions {
  templateKey: TemplateKey;
  variables: Record<string, unknown>;
  outputBasename: string;    // ファイル名のベース（拡張子なし）
  uploadToDrive?: boolean;   // デフォルト: true
  driveFolderKey?: string;
}

export interface RenderedDocument {
  filename: string;
  localPath: string;
  driveUrl?: string;
}

function compileTemplateHtml(templateKey: TemplateKey, variables: Record<string, unknown>): string {
  const source = loadTemplateSource(templateKey);
  const merged = { ...ARCLIGHT_DEFAULTS, ...variables };
  const template = Handlebars.compile(source);
  return template(merged);
}

// ================================================================
// メインレンダリング関数
// ================================================================

/**
 * テンプレートキーを指定して文書を生成する
 * ARCLIGHT_DEFAULTSは自動的にマージされる
 */
export async function renderTemplate(options: RenderOptions): Promise<RenderedDocument> {
  const { templateKey, variables, outputBasename } = options;
  const uploadDrive = options.uploadToDrive !== false;
  const html = compileTemplateHtml(templateKey, variables);
  return renderHtmlDocument({
    html,
    outputBasename,
    uploadToDrive: uploadDrive,
    driveFolderKey: options.driveFolderKey,
  });
}

export interface RenderHtmlOptions {
  html: string;
  outputBasename: string;
  uploadToDrive?: boolean;
  driveFolderKey?: string;
}

export async function renderHtmlDocument(options: RenderHtmlOptions): Promise<RenderedDocument> {
  const { html, outputBasename } = options;
  const uploadDrive = options.uploadToDrive !== false;
  const requirePdf = process.env.REQUIRE_PDF_OUTPUT === "1";

  // 一時ファイルに保存
  const tmpDir = path.resolve(__dirname, "../../tmp");
  fs.mkdirSync(tmpDir, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
  const safeBasename = outputBasename.replace(/[/\\:*?"<>|]/g, "_");
  const htmlPath = path.join(tmpDir, `${safeBasename}_${ts}.html`);
  const pdfPath = path.join(tmpDir, `${safeBasename}_${ts}.pdf`);

  fs.writeFileSync(htmlPath, html, "utf-8");

  // WeasyPrint でPDF化
  let finalPath = htmlPath;
  let filename = path.basename(htmlPath);

  const weasyPrintCommand = resolveWeasyPrintCommand();
  if (weasyPrintCommand) {
    try {
      execSync(`${weasyPrintCommand} "${htmlPath}" "${pdfPath}"`, { timeout: 30_000 });
      finalPath = pdfPath;
      filename = path.basename(pdfPath);
      fs.unlinkSync(htmlPath);
      console.log(`[Renderer] PDF生成: ${filename}`);
    } catch (e) {
      if (requirePdf) {
        throw new Error(`PDF生成に失敗しました。WeasyPrint実行エラー: ${e}`);
      }
      console.warn(`[Renderer] WeasyPrint失敗、HTMLで続行: ${e}`);
    }
  } else {
    if (requirePdf) {
      throw new Error("PDF生成に失敗しました。WeasyPrintコマンドが利用できません。");
    }
    console.log(`[Renderer] WeasyPrint未インストール、HTMLで保存: ${filename}`);
  }

  const result: RenderedDocument = { filename, localPath: finalPath };

  // Google Driveにアップロード
  if (uploadDrive) {
    try {
      result.driveUrl = options.driveFolderKey
        ? await tryUploadToDriveFolder(filename, finalPath, options.driveFolderKey)
        : await tryUploadToDrive(filename, finalPath);
      console.log(`[Renderer] Drive保管: ${result.driveUrl}`);
    } catch (e) {
      console.error(`[Renderer] Drive保管失敗: ${e}`);
    }
  }

  return result;
}

/**
 * 複数テンプレートを一括生成する（ライセンス契約書+個別条件 等）
 */
export async function renderMultipleTemplates(
  items: RenderOptions[]
): Promise<RenderedDocument[]> {
  const results: RenderedDocument[] = [];
  for (const item of items) {
    results.push(await renderTemplate(item));
  }
  return results;
}

export function renderTemplateHtml(
  templateKey: TemplateKey,
  variables: Record<string, unknown>
): string {
  return compileTemplateHtml(templateKey, variables);
}

export function extractTemplateVariables(templateKey: TemplateKey): string[] {
  const source = loadTemplateSource(templateKey);
  return Array.from(extractTemplateVariablesFromSource(source));
}

export function renderTemplateHtmlWithMapping(
  templateKey: TemplateKey,
  variables: Record<string, unknown>
): string {
  const source = loadTemplateSource(templateKey);
  const instrumented = instrumentTemplateSourceForMapping(source);
  const merged = { ...ARCLIGHT_DEFAULTS, ...variables };
  const template = Handlebars.compile(instrumented);
  return template(merged);
}

// ================================================================
// ユーティリティ
// ================================================================

function resolveWeasyPrintCommand(): string | null {
  const candidates = [
    process.env.WEASYPRINT_COMMAND,
    "weasyprint",
    "python -m weasyprint",
    `"${path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Python", "Python312", "python.exe")}" -m weasyprint`,
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    try {
      execSync(`${candidate} --version`, { stdio: "pipe" });
      return candidate;
    } catch {
      // try next
    }
  }
  return null;
}

const MUSTACHE_PATTERN = /{{\s*([^{}]+?)\s*}}/g;
const SIMPLE_VARIABLE_PATTERN = /^[A-Za-z0-9_$.\-ぁ-んァ-ヶー一-龠]+$/;
const RESERVED_TOKENS = new Set(["else", "this"]);

function loadTemplateSource(templateKey: TemplateKey): string {
  const templateFile = TEMPLATE_MAP[templateKey];
  const templatePath = path.resolve(__dirname, "../../templates", templateFile);
  if (!fs.existsSync(templatePath)) {
    throw new Error(`テンプレートファイルが見つかりません: ${templateFile}`);
  }
  return fs.readFileSync(templatePath, "utf-8");
}

function extractTemplateVariablesFromSource(source: string): Set<string> {
  const variables = new Set<string>();
  source.replace(MUSTACHE_PATTERN, (_token, rawInner: string) => {
    const inner = String(rawInner ?? "").trim();
    if (isSimpleTemplateVariable(inner)) {
      variables.add(inner);
    }
    return "";
  });
  return variables;
}

function instrumentTemplateSourceForMapping(source: string): string {
  return source.replace(MUSTACHE_PATTERN, (token, rawInner: string) => {
    const inner = String(rawInner ?? "").trim();
    if (!isSimpleTemplateVariable(inner)) {
      return token;
    }
    const escapedInner = inner.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `{{{lb_map "${escapedInner}" ${inner}}}}`;
  });
}

function isSimpleTemplateVariable(value: string): boolean {
  if (!value) return false;
  if (RESERVED_TOKENS.has(value)) return false;
  if (value.startsWith("#") || value.startsWith("/") || value.startsWith(">") || value.startsWith("!")) {
    return false;
  }
  if (!SIMPLE_VARIABLE_PATTERN.test(value)) {
    return false;
  }
  return true;
}

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * 日付を「YYYY年MM月DD日」形式に変換
 */
export function formatDateJa(d: Date | string): string {
  const date = d instanceof Date ? d : new Date(d);
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

/**
 * 金額をカンマ区切りに変換
 */
export function formatMoneyStr(n: number): string {
  return n.toLocaleString("ja-JP");
}
