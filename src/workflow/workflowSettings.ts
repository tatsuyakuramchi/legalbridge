import fs from "fs";
import path from "path";

export interface WorkflowDriveFolderSetting {
  key: string;
  label: string;
  folderId: string;
}

export interface WorkflowDepartmentDriveFolderRule {
  department: string;
  departmentCode: string;
  driveFolderKey: string;
}

export interface WorkflowSettings {
  version: number;
  approverSlackId: string;
  stampOperatorSlackId: string;
  intakeChannelId: string;
  defaultDriveFolderKey: string;
  driveFolderOptions: WorkflowDriveFolderSetting[];
  departmentDriveFolderRules: WorkflowDepartmentDriveFolderRule[];
}

const SETTINGS_DIR = path.resolve(__dirname, "../../data/settings");
const SETTINGS_PATH = path.join(SETTINGS_DIR, "workflow-settings.json");

const DEFAULT_SETTINGS: WorkflowSettings = {
  version: 2,
  approverSlackId: "",
  stampOperatorSlackId: "",
  intakeChannelId: "",
  defaultDriveFolderKey: "",
  driveFolderOptions: [],
  departmentDriveFolderRules: [],
};

export function getWorkflowSettings(): WorkflowSettings {
  ensureSettingsDir();
  if (!fs.existsSync(SETTINGS_PATH)) {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(DEFAULT_SETTINGS, null, 2), "utf-8");
    return DEFAULT_SETTINGS;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8")) as Partial<WorkflowSettings>;
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      approverSlackId: String(parsed.approverSlackId ?? "").trim(),
      stampOperatorSlackId: String(parsed.stampOperatorSlackId ?? "").trim(),
      intakeChannelId: String(parsed.intakeChannelId ?? "").trim(),
      defaultDriveFolderKey: String(parsed.defaultDriveFolderKey ?? "").trim(),
      driveFolderOptions: normalizeDriveFolderOptions(parsed.driveFolderOptions),
      departmentDriveFolderRules: normalizeDepartmentDriveFolderRules(parsed.departmentDriveFolderRules),
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveWorkflowSettings(input: Partial<WorkflowSettings>): WorkflowSettings {
  const current = getWorkflowSettings();
  const next: WorkflowSettings = {
    ...current,
    ...input,
    approverSlackId: String(input.approverSlackId ?? current.approverSlackId ?? "").trim(),
    stampOperatorSlackId: String(input.stampOperatorSlackId ?? current.stampOperatorSlackId ?? "").trim(),
    intakeChannelId: String(input.intakeChannelId ?? current.intakeChannelId ?? "").trim(),
    defaultDriveFolderKey: String(input.defaultDriveFolderKey ?? current.defaultDriveFolderKey ?? "").trim(),
    driveFolderOptions: normalizeDriveFolderOptions(input.driveFolderOptions ?? current.driveFolderOptions),
    departmentDriveFolderRules: normalizeDepartmentDriveFolderRules(input.departmentDriveFolderRules ?? current.departmentDriveFolderRules),
  };

  ensureSettingsDir();
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2), "utf-8");
  return next;
}

function ensureSettingsDir() {
  fs.mkdirSync(SETTINGS_DIR, { recursive: true });
}

function normalizeDriveFolderOptions(input: unknown): WorkflowDriveFolderSetting[] {
  if (!Array.isArray(input)) return [];

  return input
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    .map((item) => ({
      key: String(item.key ?? "").trim(),
      label: String(item.label ?? "").trim(),
      folderId: String(item.folderId ?? "").trim(),
    }))
    .filter((item) => item.key && item.label && item.folderId);
}

function normalizeDepartmentDriveFolderRules(input: unknown): WorkflowDepartmentDriveFolderRule[] {
  if (!Array.isArray(input)) return [];

  return input
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    .map((item) => ({
      department: String(item.department ?? "").trim(),
      departmentCode: String(item.departmentCode ?? "").trim(),
      driveFolderKey: String(item.driveFolderKey ?? "").trim(),
    }))
    .filter((item) => (item.department || item.departmentCode) && item.driveFolderKey);
}
