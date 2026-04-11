export interface DriveFolderOption {
  key: string;
  label: string;
  folderId?: string;
}

export function listDriveFolderOptions(): DriveFolderOption[] {
  const parsed = parseDriveFolderOptions(process.env.GOOGLE_DRIVE_FOLDER_OPTIONS);
  if (parsed.length > 0) {
    return parsed;
  }

  return [{
    key: process.env.GOOGLE_DRIVE_FOLDER_DEFAULT_KEY || "default",
    label: process.env.GOOGLE_DRIVE_FOLDER_DEFAULT_LABEL || "法務共通",
    folderId: process.env.GOOGLE_DRIVE_FOLDER_ID,
  }];
}

export function getDefaultDriveFolderKey(): string {
  const options = listDriveFolderOptions();
  const configuredDefault = process.env.GOOGLE_DRIVE_FOLDER_DEFAULT_KEY;
  if (configuredDefault && options.some((option) => option.key === configuredDefault)) {
    return configuredDefault;
  }
  return options[0]?.key ?? "default";
}

export function resolveDriveFolderId(driveFolderKey?: string): string | undefined {
  const options = listDriveFolderOptions();
  const selected = options.find((option) => option.key === driveFolderKey);
  return selected?.folderId || process.env.GOOGLE_DRIVE_FOLDER_ID;
}

export function resolveDriveFolderLabel(driveFolderKey?: string): string {
  const options = listDriveFolderOptions();
  return options.find((option) => option.key === driveFolderKey)?.label
    ?? options.find((option) => option.key === getDefaultDriveFolderKey())?.label
    ?? "法務共通";
}

function parseDriveFolderOptions(raw: string | undefined): DriveFolderOption[] {
  if (!raw?.trim()) return [];

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
        .map((item) => ({
          key: String(item.key ?? "").trim(),
          label: String(item.label ?? "").trim(),
          folderId: item.folderId == null ? undefined : String(item.folderId).trim(),
        }))
        .filter((item) => item.key && item.label);
    }

    if (parsed && typeof parsed === "object") {
      return Object.entries(parsed as Record<string, unknown>)
        .map(([key, value]) => {
          if (value && typeof value === "object") {
            const item = value as Record<string, unknown>;
            return {
              key,
              label: String(item.label ?? key).trim(),
              folderId: item.folderId == null ? undefined : String(item.folderId).trim(),
            };
          }
          return {
            key,
            label: key,
            folderId: value == null ? undefined : String(value).trim(),
          };
        })
        .filter((item) => item.key && item.label);
    }
  } catch {
    return [];
  }

  return [];
}
