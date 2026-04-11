import dotenv from "dotenv";
dotenv.config();

import { backlog } from "../backlog/client";

type EnvFieldEntry = {
  envKey: string;
  fieldId: number;
};

async function main() {
  const customFields = await backlog.listCustomFields();
  const issueTypes = await backlog.listIssueTypes();
  const envFieldEntries = Object.entries(process.env)
    .filter(([key, value]) => key.startsWith("BACKLOG_FIELD_") && value && /^\d+$/.test(value))
    .map(([envKey, value]) => ({ envKey, fieldId: Number(value) }))
    .sort((a, b) => a.envKey.localeCompare(b.envKey));

  const issueTypeMap = new Map(issueTypes.map((item) => [item.id, item.name]));
  const envFieldMap = new Map<number, string[]>();
  for (const entry of envFieldEntries) {
    const current = envFieldMap.get(entry.fieldId) ?? [];
    current.push(entry.envKey);
    envFieldMap.set(entry.fieldId, current);
  }

  const payload = customFields
    .slice()
    .sort((a, b) => a.id - b.id)
    .map((field) => ({
      id: field.id,
      name: field.name,
      typeId: field.typeId ?? null,
      required: field.required ?? null,
      description: field.description ?? "",
      applicableIssueTypes: (field.applicableIssueTypes ?? [])
        .map((item) => item.name || issueTypeMap.get(item.id) || String(item.id)),
      envKeys: envFieldMap.get(field.id) ?? [],
    }));

  console.log(JSON.stringify({
    projectKey: process.env.BACKLOG_PROJECT_KEY ?? "",
    customFieldCount: payload.length,
    fields: payload,
    unmappedEnvFields: envFieldEntries.filter((entry) => !payload.some((field) => field.id === entry.fieldId)),
  }, null, 2));
}

main().catch((error) => {
  console.error("[Backlog] カスタム属性一覧取得失敗");
  console.error(error);
  process.exit(1);
});
