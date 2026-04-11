import express from "express";
import { App, ExpressReceiver, LogLevel } from "@slack/bolt";
import { registerSlackHandlers } from "../slack/handlers";
import { GatewayRuntimeStatus, createGatewayRuntimeStatus, renderGatewayStatusHtml } from "./status";

export function createGatewayApp(input?: {
  slackBotToken?: string;
  slackSigningSecret?: string;
  logLevel?: LogLevel;
  tokenVerificationEnabled?: boolean;
  authorize?: any;
  registerHandlers?: (app: App) => void;
  status?: GatewayRuntimeStatus;
}) {
  const slackBotToken = String(input?.slackBotToken ?? process.env.SLACK_BOT_TOKEN ?? "").trim();
  const slackSigningSecret = String(input?.slackSigningSecret ?? process.env.SLACK_SIGNING_SECRET ?? "").trim();

  const missing = [
    !slackBotToken && !input?.authorize ? "SLACK_BOT_TOKEN" : "",
    !slackSigningSecret ? "SLACK_SIGNING_SECRET" : "",
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(`Slack gateway 用の環境変数が未設定です: ${missing.join(", ")}`);
  }

  const receiver = new ExpressReceiver({
    signingSecret: slackSigningSecret,
    endpoints: {
      commands: "/slack/commands",
      actions: "/slack/interactions",
      events: "/slack/events",
    },
    processBeforeResponse: false,
  });

  const app = new App({
    token: slackBotToken || undefined,
    authorize: input?.authorize,
    receiver,
    logLevel: input?.logLevel ?? (process.env.LOG_LEVEL === "debug" ? LogLevel.DEBUG : LogLevel.INFO),
    tokenVerificationEnabled: input?.tokenVerificationEnabled,
  });

  (input?.registerHandlers ?? registerSlackHandlers)(app);

  const httpApp = receiver.app as express.Express;
  const runtimeStatus = createGatewayRuntimeStatus(input?.status);
  httpApp.get("/health", (_req, res) => {
    res.status(runtimeStatus.ready ? 200 : 503).json({
      status: runtimeStatus.ready ? "ok" : "degraded",
      service: "public-slack-gateway",
      ...runtimeStatus,
    });
  });
  httpApp.get("/ready", (_req, res) => {
    res.status(runtimeStatus.ready ? 200 : 503).json({
      ready: runtimeStatus.ready,
      mode: runtimeStatus.mode,
      blockingIssues: runtimeStatus.blockingIssues,
      warnings: runtimeStatus.warnings,
      updatedAt: runtimeStatus.updatedAt,
    });
  });
  httpApp.get("/status", (_req, res) => {
    res.status(runtimeStatus.ready ? 200 : 503).type("html").send(renderGatewayStatusHtml(runtimeStatus));
  });
  httpApp.get("/status.json", (_req, res) => {
    res.status(runtimeStatus.ready ? 200 : 503).json({
      service: "public-slack-gateway",
      ...runtimeStatus,
    });
  });

  return {
    app,
    receiver,
    httpApp,
    slackBotToken,
    slackSigningSecret,
    runtimeStatus,
  };
}
