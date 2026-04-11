import axios from "axios";
import fs from "fs";
import path from "path";
import { google } from "googleapis";
import { resolveDriveFolderId } from "./driveFolders";

export interface StoredFileResult {
  localPath: string;
  driveUrl?: string;
}

export async function downloadSlackFile(params: {
  url: string;
  token: string;
  outputBasename: string;
  uploadToDrive?: boolean;
}): Promise<StoredFileResult> {
  const targetDir = path.resolve(__dirname, "../../tmp/stamp-uploads");
  fs.mkdirSync(targetDir, { recursive: true });

  const extension = safeExtensionFromUrl(params.url);
  const localPath = path.join(targetDir, `${sanitizeBasename(params.outputBasename)}${extension}`);
  const response = await axios.get<ArrayBuffer>(params.url, {
    responseType: "arraybuffer",
    headers: {
      Authorization: `Bearer ${params.token}`,
    },
  });
  fs.writeFileSync(localPath, Buffer.from(response.data));

  const driveUrl = params.uploadToDrive === false
    ? undefined
    : await tryUploadToDrive(path.basename(localPath), localPath);
  return { localPath, driveUrl };
}

export async function tryUploadToDrive(filename: string, filePath: string): Promise<string | undefined> {
  const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH;
  const folderId = resolveDriveFolderId();
  if (!keyPath || !folderId) {
    return undefined;
  }
  return uploadToSpecificDriveFolder(filename, filePath, keyPath, folderId);
}

export async function tryUploadToDriveFolder(
  filename: string,
  filePath: string,
  driveFolderKey?: string,
): Promise<string | undefined> {
  const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH;
  const folderId = resolveDriveFolderId(driveFolderKey);
  if (!keyPath || !folderId) {
    return undefined;
  }

  return uploadToSpecificDriveFolder(filename, filePath, keyPath, folderId);
}

async function uploadToSpecificDriveFolder(
  filename: string,
  filePath: string,
  keyPath: string,
  folderId: string,
): Promise<string> {
  const auth = new google.auth.GoogleAuth({
    keyFile: keyPath,
    scopes: ["https://www.googleapis.com/auth/drive.file"],
  });
  const drive = google.drive({ version: "v3", auth });
  const mimeType = filename.toLowerCase().endsWith(".pdf") ? "application/pdf" : "application/octet-stream";

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

function sanitizeBasename(value: string): string {
  return value.replace(/[/\\:*?"<>|]/g, "_");
}

function safeExtensionFromUrl(value: string): string {
  const match = value.match(/(\.[a-zA-Z0-9]+)(?:\?|$)/);
  return match ? match[1] : ".pdf";
}
