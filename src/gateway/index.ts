import dotenv from "dotenv";
dotenv.config();

import express from "express";
import { validateBacklogConfiguration } from "../backlog/configValidator";
import { registerSlackGatewayHandlers } from "../slack/gatewayHandlers";
import { createGatewayApp } from "./app";
import { validateGatewayConfiguration } from "./configValidator";
import { createGatewayRuntimeStatus, renderGatewayStatusHtml } from "./status";

validateGatewayConfiguration();

(async () => {
  const validation = await validateBacklogConfiguration();
  const port = Number(process.env.PORT ?? 8080);
  if (validation.blockingIssues.length > 0) {
    console.error("[Gateway] 起票を壊す設定差分があるため、Slack-Backlog 受付サービスを起動しません。");
    for (const issue of validation.blockingIssues) {
      console.error(`  - ${issue}`);
    }

    const status = createGatewayRuntimeStatus({
      mode: "degraded",
      ready: false,
      warnings: validation.warnings,
      blockingIssues: validation.blockingIssues,
      issueTypes: validation.issueTypes,
      fields: validation.fields,
    });
    const degradedApp = express();
    degradedApp.get("/health", (_req, res) => {
      res.status(503).json({
        status: "degraded",
        service: "public-slack-gateway",
        ...status,
      });
    });
    degradedApp.get("/ready", (_req, res) => {
      res.status(503).json({
        ready: false,
        mode: status.mode,
        blockingIssues: status.blockingIssues,
        warnings: status.warnings,
        updatedAt: status.updatedAt,
      });
    });
    degradedApp.get("/status", (_req, res) => {
      res.status(503).type("html").send(renderGatewayStatusHtml(status));
    });
    degradedApp.get("/status.json", (_req, res) => {
      res.status(503).json({
        service: "public-slack-gateway",
        ...status,
      });
    });

    degradedApp.listen(port, () => {
      console.log(`\n⚠️  LegalBridge Slack-Backlog gateway is running in degraded mode on port ${port}`);
      console.log(`   Health: http://0.0.0.0:${port}/health`);
      console.log(`   Ready: http://0.0.0.0:${port}/ready`);
      console.log(`   Status: http://0.0.0.0:${port}/status`);
      console.log(`   Status JSON: http://0.0.0.0:${port}/status.json`);
      console.log(`   Slack endpoints are disabled until blocking issues are resolved.\n`);
    });
    return;
  }

  const { httpApp, slackBotToken, slackSigningSecret } = createGatewayApp({
    registerHandlers: registerSlackGatewayHandlers,
    status: createGatewayRuntimeStatus({
      mode: "active",
      ready: true,
      warnings: validation.warnings,
      blockingIssues: validation.blockingIssues,
      issueTypes: validation.issueTypes,
      fields: validation.fields,
    }),
  });

  console.log(`[Gateway] Slack token length: ${slackBotToken.length}`);
  console.log(`[Gateway] Slack signing secret length: ${slackSigningSecret.length}`);

  httpApp.listen(port, () => {
    console.log(`\n🚀 LegalBridge Slack-Backlog gateway started on port ${port}`);
    console.log(`   Health: http://0.0.0.0:${port}/health`);
    console.log(`   Ready: http://0.0.0.0:${port}/ready`);
    console.log(`   Status: http://0.0.0.0:${port}/status`);
    console.log(`   Status JSON: http://0.0.0.0:${port}/status.json`);
    console.log(`   Slash Commands: /slack/commands`);
    console.log(`   Interactivity: /slack/interactions\n`);
  });
})();
