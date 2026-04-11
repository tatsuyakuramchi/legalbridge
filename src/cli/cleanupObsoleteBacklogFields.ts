import dotenv from "dotenv";
dotenv.config();

import { backlog } from "../backlog/client";

const OBSOLETE_ENV_KEYS = [
  "BACKLOG_FIELD_CALC_TYPE_LABEL",
  "BACKLOG_FIELD_ROYALTY_RATE_LABEL",
  "BACKLOG_FIELD_PAYMENT_TERMS_TEXT",
  "BACKLOG_FIELD_MG_AG_TEXT",
] as const;

async function main() {
  const existingFields = await backlog.listCustomFields();
  const fieldMap = new Map(existingFields.map((field) => [field.id, field]));
  const results: Array<Record<string, unknown>> = [];

  for (const envKey of OBSOLETE_ENV_KEYS) {
    const fieldIdRaw = process.env[envKey];
    if (!fieldIdRaw || !/^\d+$/.test(fieldIdRaw)) {
      results.push({
        envKey,
        status: "skipped",
        reason: "field id not configured",
      });
      continue;
    }

    const fieldId = Number(fieldIdRaw);
    const field = fieldMap.get(fieldId);
    if (!field) {
      results.push({
        envKey,
        fieldId,
        status: "absent",
      });
      continue;
    }

    await backlog.deleteCustomField(fieldId);
    results.push({
      envKey,
      fieldId,
      name: field.name,
      status: "deleted",
    });
  }

  console.log(JSON.stringify({
    projectKey: process.env.BACKLOG_PROJECT_KEY ?? "",
    results,
  }, null, 2));
}

main().catch((error) => {
  console.error("[Backlog] 旧カスタム属性の削除に失敗");
  if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error(String(error));
  }
  process.exit(1);
});
