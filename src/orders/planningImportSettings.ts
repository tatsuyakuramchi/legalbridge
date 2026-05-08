import fs from "fs";
import path from "path";

export interface PlanningImportSettings {
  version: number;
  projectTitleSource: "filename" | "manual";
  projectTitleManualValue: string;
  requesterSlackUserIdColumn: string;
  orderDateColumn: string;
  vendorLookupColumn: string;
  vendorCodeColumn: string;
  itemNameColumn: string;
  completionDateColumn: string;
  completionDateFallbackColumn: string;
  finalDeadlineColumn: string;
  quantityColumn: string;
  unitPriceColumn: string;
  paymentDateColumn: string;
  amountColumn: string;
  amountFallbackColumn: string;
  detailColumns: string[];
  constants: {
    category: string;
    payMethod: string;
    rightsLabel: string;
    transferFee: string;
    transferFeePayer: string;
    deliveryDateLabel: string;
    paymentDateLabel: string;
    finalDeadlineFallback: string;
  };
  defaults: {
    specialTerms: string;
    remarks: string;
    acceptMethod: string;
    acceptReplyDueDate: string;
  };
}

export type PlanningImportProfileId = "planning" | "publishing_bulk";

export interface PlanningImportProfile {
  id: PlanningImportProfileId;
  label: string;
  settings: PlanningImportSettings;
}

interface PlanningImportSettingsStore {
  version: number;
  activeProfileId: PlanningImportProfileId;
  profiles: PlanningImportProfile[];
}

const SETTINGS_DIR = path.resolve(__dirname, "../../data/settings");
const SETTINGS_PATH = path.join(SETTINGS_DIR, "planning-import.json");

const DEFAULT_SETTINGS: PlanningImportSettings = {
  version: 1,
  projectTitleSource: "filename",
  projectTitleManualValue: "",
  requesterSlackUserIdColumn: "",
  orderDateColumn: "",
  vendorLookupColumn: "作家名",
  vendorCodeColumn: "vendorID",
  itemNameColumn: "カード名",
  completionDateColumn: "完成",
  completionDateFallbackColumn: "完成希望",
  finalDeadlineColumn: "B〆",
  quantityColumn: "",
  unitPriceColumn: "",
  paymentDateColumn: "",
  amountColumn: "管理費込み",
  amountFallbackColumn: "原稿料",
  detailColumns: [
    "カードNo.",
    "カード名",
    "色",
    "カード種類",
    "キャラ備考",
    "特徴",
    "画角",
    "イラスト指定",
  ],
  constants: {
    category: "イラスト制作",
    payMethod: "一括",
    rightsLabel: "発注書",
    transferFee: "報酬に含む",
    transferFeePayer: "発注者",
    deliveryDateLabel: "完成",
    paymentDateLabel: "完成の翌月20日払い",
    finalDeadlineFallback: "別途協議",
  },
  defaults: {
    specialTerms: "",
    remarks: "",
    acceptMethod: "",
    acceptReplyDueDate: "",
  },
};

const PROFILE_LABELS: Record<PlanningImportProfileId, string> = {
  planning: "企画発注書",
  publishing_bulk: "出版一括発注書",
};

function buildDefaultProfiles(): PlanningImportProfile[] {
  return [
    {
      id: "planning",
      label: PROFILE_LABELS.planning,
      settings: DEFAULT_SETTINGS,
    },
    {
      id: "publishing_bulk",
      label: PROFILE_LABELS.publishing_bulk,
      settings: {
        ...DEFAULT_SETTINGS,
        projectTitleSource: "filename",
        projectTitleManualValue: "",
        requesterSlackUserIdColumn: "担当者ID",
        orderDateColumn: "発注日",
        vendorLookupColumn: "支払先（ペンネーム）",
        vendorCodeColumn: "コード",
        itemNameColumn: "書籍名",
        completionDateColumn: "初校締切",
        completionDateFallbackColumn: "再校締切",
        finalDeadlineColumn: "校了予定",
        quantityColumn: "数量",
        unitPriceColumn: "単価（税込）",
        paymentDateColumn: "支払日",
        amountColumn: "発注金額（税別）",
        amountFallbackColumn: "原稿料",
        detailColumns: [
          "業務概要",
          "業務詳細（仕様）",
          "備考",
        ],
        constants: {
          ...DEFAULT_SETTINGS.constants,
          category: "出版制作",
          rightsLabel: "出版一括発注書",
          deliveryDateLabel: "初校締切",
          paymentDateLabel: "校了月の翌月20日払い",
        },
        defaults: {
          ...DEFAULT_SETTINGS.defaults,
          remarks: "出版制作進行に準じて納品・修正対応を行うものとする。",
        },
      },
    },
  ];
}

function buildDefaultStore(): PlanningImportSettingsStore {
  return {
    version: 2,
    activeProfileId: "planning",
    profiles: buildDefaultProfiles(),
  };
}

export function getPlanningImportProfiles(): PlanningImportProfile[] {
  return getPlanningImportSettingsStore().profiles;
}

export function getPlanningImportProfile(profileId?: string): PlanningImportProfile {
  const store = getPlanningImportSettingsStore();
  const resolvedProfileId = resolveProfileId(profileId, store.activeProfileId);
  return store.profiles.find((profile) => profile.id === resolvedProfileId)
    ?? store.profiles[0];
}

export function getActivePlanningImportProfileId(): PlanningImportProfileId {
  return getPlanningImportSettingsStore().activeProfileId;
}

export function getPlanningImportSettings(profileId?: string): PlanningImportSettings {
  return getPlanningImportProfile(profileId).settings;
}

export function savePlanningImportSettings(
  input: Partial<PlanningImportSettings>,
  profileId?: string,
  makeActive = true,
): PlanningImportProfile {
  const current = getPlanningImportSettingsStore();
  const resolvedProfileId = resolveProfileId(profileId, current.activeProfileId);
  const nextProfiles = current.profiles.map((profile) => {
    if (profile.id !== resolvedProfileId) return profile;
    const nextSettings = mergeSettings(profile.settings, input);
    return {
      ...profile,
      settings: nextSettings,
    };
  });
  const nextStore: PlanningImportSettingsStore = {
    ...current,
    activeProfileId: makeActive ? resolvedProfileId : current.activeProfileId,
    profiles: nextProfiles,
  };
  persistStore(nextStore);
  return nextStore.profiles.find((profile) => profile.id === resolvedProfileId) ?? nextStore.profiles[0];
}

export function setActivePlanningImportProfile(profileId: string): PlanningImportProfile {
  const current = getPlanningImportSettingsStore();
  const resolvedProfileId = resolveProfileId(profileId, current.activeProfileId);
  const nextStore: PlanningImportSettingsStore = {
    ...current,
    activeProfileId: resolvedProfileId,
  };
  persistStore(nextStore);
  return nextStore.profiles.find((profile) => profile.id === resolvedProfileId) ?? nextStore.profiles[0];
}

function getPlanningImportSettingsStore(): PlanningImportSettingsStore {
  ensureSettingsDir();
  if (!fs.existsSync(SETTINGS_PATH)) {
    const next = buildDefaultStore();
    persistStore(next);
    return next;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8")) as Partial<PlanningImportSettingsStore & PlanningImportSettings>;
    const normalized = normalizeStore(parsed);
    persistStore(normalized);
    return normalized;
  } catch {
    const next = buildDefaultStore();
    persistStore(next);
    return next;
  }
}

function normalizeStore(parsed: Partial<PlanningImportSettingsStore & PlanningImportSettings>): PlanningImportSettingsStore {
  if (Array.isArray(parsed.profiles) && parsed.profiles.length > 0) {
    const defaultStore = buildDefaultStore();
    const profiles = defaultStore.profiles.map((defaultProfile) => {
      const incoming = parsed.profiles?.find((profile) => profile.id === defaultProfile.id);
      return {
        id: defaultProfile.id,
        label: String(incoming?.label ?? defaultProfile.label),
        settings: mergeSettings(defaultProfile.settings, incoming?.settings ?? {}),
      };
    });
    return {
      version: 2,
      activeProfileId: resolveProfileId(parsed.activeProfileId, defaultStore.activeProfileId),
      profiles,
    };
  }

  const migratedPlanningSettings = mergeSettings(DEFAULT_SETTINGS, parsed);
  const defaultStore = buildDefaultStore();
  return {
    version: 2,
    activeProfileId: "planning",
    profiles: defaultStore.profiles.map((profile) => profile.id === "planning"
      ? {
          ...profile,
          settings: migratedPlanningSettings,
        }
      : profile),
  };
}

function mergeSettings(current: PlanningImportSettings, input: Partial<PlanningImportSettings>): PlanningImportSettings {
  return {
    ...current,
    ...input,
    constants: {
      ...current.constants,
      ...(input.constants ?? {}),
    },
    defaults: {
      ...current.defaults,
      ...(input.defaults ?? {}),
    },
    detailColumns: Array.isArray(input.detailColumns)
      ? input.detailColumns.map((value) => String(value).trim()).filter(Boolean)
      : current.detailColumns,
  };
}

function resolveProfileId(profileId: string | undefined, fallback: PlanningImportProfileId): PlanningImportProfileId {
  return profileId === "publishing_bulk" ? "publishing_bulk" : profileId === "planning" ? "planning" : fallback;
}

function persistStore(store: PlanningImportSettingsStore): void {
  ensureSettingsDir();
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(store, null, 2), "utf-8");
}

function ensureSettingsDir() {
  fs.mkdirSync(SETTINGS_DIR, { recursive: true });
}
