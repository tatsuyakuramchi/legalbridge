import fs from "fs";
import path from "path";

export interface WorkflowSettings {
  version: number;
  approverSlackId: string;
  stampOperatorSlackId: string;
  intakeChannelId: string;
}

const SETTINGS_DIR = path.resolve(__dirname, "../../data/settings");
const SETTINGS_PATH = path.join(SETTINGS_DIR, "workflow-settings.json");

const DEFAULT_SETTINGS: WorkflowSettings = {
  version: 1,
  approverSlackId: "",
  stampOperatorSlackId: "",
  intakeChannelId: "",
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
  };

  ensureSettingsDir();
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2), "utf-8");
  return next;
}

function ensureSettingsDir() {
  fs.mkdirSync(SETTINGS_DIR, { recursive: true });
}
