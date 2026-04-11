import dotenv from "dotenv";
dotenv.config();

import fs from "fs";
import path from "path";
import { validateBacklogConfiguration } from "../backlog/configValidator";
import { createGatewayRuntimeStatus } from "../gateway/status";

async function main() {
  const validation = await validateBacklogConfiguration();
  const status = createGatewayRuntimeStatus({
    mode: validation.blockingIssues.length > 0 ? "degraded" : "active",
    ready: validation.blockingIssues.length === 0,
    warnings: validation.warnings,
    blockingIssues: validation.blockingIssues,
    issueTypes: validation.issueTypes,
    fields: validation.fields,
  });

  const output = {
    service: "public-slack-gateway",
    checkedAt: new Date().toISOString(),
    ...status,
  };

  const outputPath = String(process.env.GATEWAY_STATUS_OUTPUT_PATH ?? "").trim();
  if (outputPath) {
    const resolved = path.resolve(outputPath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, JSON.stringify(output, null, 2), "utf-8");
    console.log(`[GatewayCheck] JSON を出力しました: ${resolved}`);
  }

  console.log(JSON.stringify(output, null, 2));

  if (!status.ready) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("[GatewayCheck] 設定確認に失敗しました。");
  console.error(error);
  process.exit(1);
});
