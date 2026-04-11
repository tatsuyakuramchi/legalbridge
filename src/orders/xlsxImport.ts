import * as XLSX from "xlsx";

export interface XlsxSheetSummary {
  name: string;
  rowCount: number;
  headers: string[];
  score: number;
}

export function listWorkbookSheetsFromBase64(base64: string): XlsxSheetSummary[] {
  const workbook = readWorkbook(base64);
  return workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
      defval: "",
      raw: true,
    });
    const headers = extractHeadersFromSheet(sheet);
    return {
      name,
      rowCount: rows.length,
      headers,
      score: scoreHeaders(headers),
    };
  }).sort((a, b) => b.score - a.score || b.rowCount - a.rowCount);
}

export function convertWorkbookSheetToCsv(input: {
  base64: string;
  sheetName?: string;
}): { sheetName: string; csvText: string; headers: string[] } {
  const workbook = readWorkbook(input.base64);
  const sheetName = input.sheetName && workbook.Sheets[input.sheetName]
    ? input.sheetName
    : workbook.SheetNames[0];

  if (!sheetName) {
    throw new Error("Excelファイルにシートがありません。");
  }

  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    blankrows: false,
    defval: "",
    raw: true,
  });
  return {
    sheetName,
    csvText: rowsToCsv(rows),
    headers: extractHeadersFromSheet(sheet),
  };
}

function readWorkbook(base64: string): XLSX.WorkBook {
  const normalized = String(base64 ?? "").trim();
  if (!normalized) {
    throw new Error("Excelデータが空です。");
  }
  return XLSX.read(Buffer.from(normalized, "base64"), {
    type: "buffer",
    cellDates: true,
  });
}

function extractHeadersFromSheet(sheet: XLSX.WorkSheet): string[] {
  const rows = XLSX.utils.sheet_to_json<string[]>(sheet, {
    header: 1,
    blankrows: false,
    defval: "",
    raw: true,
  });
  return (rows[0] ?? []).map((value) => String(value).trim()).filter(Boolean);
}

function scoreHeaders(headers: string[]): number {
  const preferred = ["カードNo.", "カード名", "作家名", "完成", "B〆", "原稿料", "管理費込み"];
  return preferred.reduce((score, header) => score + (headers.includes(header) ? 1 : 0), 0);
}

function rowsToCsv(rows: unknown[][]): string {
  return rows
    .map((row) => row.map((value) => escapeCsv(formatCell(value))).join(","))
    .join("\n");
}

function formatCell(value: unknown): string {
  if (value instanceof Date) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
      return trimmed.slice(0, 10);
    }
    return trimmed;
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }
  return String(value ?? "");
}

function escapeCsv(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, "\"\"")}"`;
  }
  return value;
}
