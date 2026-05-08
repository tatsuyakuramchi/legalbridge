/**
 * index.ts
 * LegalBridge プロトタイプ エントリーポイント
 *
 * 起動コマンド:
 *   npm run dev
 *
 * 前提条件:
 *   1. .env ファイルを設定済みであること（.env.example を参照）
 *   2. Slack Appで Socket Mode を有効化済みであること
 *   3. Slack Appに以下のスコープを付与済みであること:
 *      - chat:write, commands, im:write, channels:read
 *   4. スラッシュコマンドをSlack Appに登録済みであること:
 *      - /法務依頼
 *      - /法務ステータス
 *      - /法務一覧
 */

import dotenv from "dotenv";
dotenv.config();

import { App, LogLevel } from "@slack/bolt";
import express from "express";
import net from "net";
import { registerSlackHandlers } from "./slack/handlers";
import { createBacklogWebhookRouter } from "./webhook/backlog";
import prisma from "./db/client";
import { startScheduler } from "./db/scheduler";
import { startBacklogPolling } from "./backlog/poller";
import { createAdminRouter } from "./admin/routes";
import { createOptionalSlackClient } from "./slack/optionalClient";
import { validateBacklogConfiguration } from "./backlog/configValidator";
import {
  getLocalRuntimeStatus,
  renderLocalRuntimeStatusHtml,
  updateLocalComponentStatus,
} from "./local/status";

// ================================================================
// 起動前の環境変数チェック
// ================================================================
const BACKLOG_ENV = [
  "BACKLOG_API_KEY",
  "BACKLOG_SPACE",
  "BACKLOG_PROJECT_KEY",
];

function isEnabled(envKey: string, defaultValue = false): boolean {
  const raw = String(process.env[envKey] ?? "").trim().toLowerCase();
  if (!raw) return defaultValue;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

const enableSlackStartup = isEnabled("ENABLE_SLACK_STARTUP", false);
const enableBacklogStartupCheck = isEnabled("ENABLE_BACKLOG_STARTUP_CHECK", false);
const enableBackgroundSync = isEnabled("ENABLE_BACKGROUND_SYNC", false);
const skipSlackStartup = process.env.SKIP_SLACK_STARTUP === "1" || !enableSlackStartup;
const hasSlackBotToken = Boolean(String(process.env.SLACK_BOT_TOKEN ?? "").trim());
const hasSlackAppToken = Boolean(String(process.env.SLACK_APP_TOKEN ?? "").trim());
const shouldStartSlackApp = !skipSlackStartup && hasSlackBotToken && hasSlackAppToken;

if (!enableSlackStartup) {
  updateLocalComponentStatus("slack", {
    severity: "disabled",
    detail: "このサービスでは Slack の常駐受付を起動しません。Slack 受付は gateway サービス側で処理します。",
  });
} else if (skipSlackStartup) {
  updateLocalComponentStatus("slack", {
    severity: "disabled",
    detail: "このサービスでは Slack の常駐受付を起動しません。Slack 受付は gateway サービス側で処理します。",
  });
}

if (!enableBacklogStartupCheck) {
  updateLocalComponentStatus("backlogConfig", {
    severity: "disabled",
    detail: "ENABLE_BACKLOG_STARTUP_CHECK 未設定のため起動時の Backlog 設定確認は行いません。",
  });
}

if (!enableBackgroundSync) {
  updateLocalComponentStatus("scheduler", {
    severity: "disabled",
    detail: "このサービスでは定期実行を行いません。定期処理は work-service 側で実行します。",
  });
  updateLocalComponentStatus("poller", {
    severity: "disabled",
    detail: "このサービスでは Backlog 同期ジョブを実行しません。必要な同期は webhook または work-service 側で処理します。",
  });
}

if (!skipSlackStartup && !shouldStartSlackApp) {
  console.warn("⚠️  Slack App は未起動です。このサービスは管理UI用途で動作し、Slack 受付は gateway サービス側で処理します。");
  updateLocalComponentStatus("slack", {
    severity: "disabled",
    detail: "このサービスは管理UI用途で動作し、Slack 受付は gateway サービス側で処理します。",
  });
}

const missingBacklogEnv = BACKLOG_ENV.filter((k) => !process.env[k]);
if (missingBacklogEnv.length > 0) {
  console.warn("⚠️  Backlog 用の環境変数が未設定です。");
  missingBacklogEnv.forEach((k) => console.warn(`   - ${k}`));
  console.warn("   管理UI と DB は起動しますが、Backlog 連携が必要な機能は利用時に失敗します。");
  if (!enableBacklogStartupCheck) {
    updateLocalComponentStatus("backlogConfig", {
      severity: "disabled",
      detail: `Backlog 環境変数未設定 (${missingBacklogEnv.join(", ")}) のため、Backlog 前提機能は利用できません。`,
      meta: {
        missingEnv: missingBacklogEnv,
      },
    });
  }
}

// ================================================================
// Slack App（必要な構成でのみ有効化）
// ================================================================
const slackApp = shouldStartSlackApp
  ? new App({
      token: process.env.SLACK_BOT_TOKEN!,
      appToken: process.env.SLACK_APP_TOKEN!,
      signingSecret: process.env.SLACK_SIGNING_SECRET!,
      socketMode: true,
      logLevel: process.env.LOG_LEVEL === "debug" ? LogLevel.DEBUG : LogLevel.INFO,
    })
  : null;

// ================================================================
// Express（Admin UI / Optional Backlog Webhook）
// Admin UI と文書生成補助のための HTTP サービス。
// ================================================================
const expressApp = express();
expressApp.use(express.json({ limit: "20mb" }));
expressApp.use(express.urlencoded({ extended: true, limit: "20mb" }));
expressApp.get("/favicon.ico", (_req, res) => {
  res.status(204).end();
});
expressApp.get("/", (_req, res) => {
  res.redirect(302, "/admin");
});

// ヘルスチェック
expressApp.get("/health", (_req, res) => {
  const runtime = getLocalRuntimeStatus();
  res.status(runtime.ready ? 200 : 503).json({
    status: runtime.ready ? "ok" : "degraded",
    timestamp: new Date().toISOString(),
    service: runtime.service,
    mode: runtime.mode,
  });
});
expressApp.get("/ready", (_req, res) => {
  const runtime = getLocalRuntimeStatus();
  res.status(runtime.ready ? 200 : 503).json({
    ready: runtime.ready,
    mode: runtime.mode,
    updatedAt: runtime.updatedAt,
    components: runtime.components.map((component) => ({
      key: component.key,
      severity: component.severity,
      detail: component.detail,
      updatedAt: component.updatedAt,
    })),
  });
});
expressApp.get("/status", (_req, res) => {
  const runtime = getLocalRuntimeStatus();
  res.status(runtime.ready ? 200 : 503).type("html").send(renderLocalRuntimeStatusHtml(runtime));
});
expressApp.get("/status.json", (_req, res) => {
  const runtime = getLocalRuntimeStatus();
  res.status(runtime.ready ? 200 : 503).json(runtime);
});

// Backlog webhook 受信ルート（ローカルでは任意利用）
const slackClient = createOptionalSlackClient(process.env.SLACK_BOT_TOKEN);
expressApp.use("/webhook/backlog", createBacklogWebhookRouter(slackClient));
expressApp.use("/admin", createAdminRouter());

// ================================================================
// ハンドラー登録
// ================================================================
if (shouldStartSlackApp && slackApp) {
  registerSlackHandlers(slackApp);
}

// ================================================================
// 起動
// ================================================================
const DEFAULT_PORT = 3000;
const LOCAL_FALLBACK_PORT = 3100;
const MAX_PORT_SCAN = 20;

async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });

    server.listen(port, "0.0.0.0");
  });
}

async function resolvePort(): Promise<number> {
  const requestedPort = Number(process.env.PORT ?? DEFAULT_PORT);
  const baseCandidates = Array.from(
    new Set([requestedPort, LOCAL_FALLBACK_PORT, DEFAULT_PORT]),
  ).filter((port) => Number.isFinite(port) && port > 0);
  const candidates = Array.from(new Set([
    ...baseCandidates,
    ...Array.from({ length: MAX_PORT_SCAN }, (_, index) => LOCAL_FALLBACK_PORT + index + 1),
  ]));

  for (const port of candidates) {
    if (await isPortAvailable(port)) {
      if (port !== requestedPort) {
        console.warn(
          `\n⚠️  Port ${requestedPort} is already in use. Falling back to ${port}.`,
        );
      }
      return port;
    }
  }

  throw new Error(
    `No available port found. Tried: ${candidates.join(", ")}`,
  );
}

async function listenExpress(app: express.Express, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = app.listen(port, () => resolve());
    server.once("error", reject);
  });
}

function logStartupError(scope: string, error: unknown): string {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(`[Startup] ${scope} でエラーが発生しました。`, error);
  return message;
}

void (async () => {
  // DB接続確認
  try {
    await prisma.$connect();
    console.log(`\n✅ DB接続成功: ${process.env.DATABASE_URL?.split("@")[1] ?? "localhost"}`);
    updateLocalComponentStatus("db", {
      severity: "ok",
      detail: "DB 接続に成功しました。",
      success: true,
      meta: {
        databaseHost: process.env.DATABASE_URL?.split("@")[1] ?? "localhost",
      },
    });
  } catch (e) {
    console.warn("⚠️ DB接続失敗（UI確認モードで継続）:", e instanceof Error ? e.message : String(e));
    updateLocalComponentStatus("db", {
      severity: "error",
      detail: e instanceof Error ? e.message : String(e),
      error: true,
    });
    // DB未接続でも Admin UI は起動する（UI確認・CSV機能のデモ用）
  }

  const port = await resolvePort();

  if (enableBacklogStartupCheck) {
    const backlogValidation = await validateBacklogConfiguration();
    updateLocalComponentStatus("backlogConfig", {
      severity: backlogValidation.blockingIssues.length > 0
        ? "warning"
        : "ok",
      detail: backlogValidation.blockingIssues.length > 0
        ? `Backlog 設定に blocking issue があります (${backlogValidation.blockingIssues.length}件)。`
        : backlogValidation.warnings.length > 0
          ? `Backlog の最小必須設定は満たしています。任意設定または DB 移管予定項目に warning があります (${backlogValidation.warnings.length}件)。`
          : "Backlog 設定差分はありません。",
      success: backlogValidation.blockingIssues.length === 0 && backlogValidation.warnings.length === 0,
      meta: {
        warningCount: backlogValidation.warnings.length,
        blockingIssueCount: backlogValidation.blockingIssues.length,
        blockingIssues: backlogValidation.blockingIssues,
      },
    });
  }

  // Express起動（Admin UI / Optional Backlog Webhook）
  await listenExpress(expressApp, port);
  console.log(`\n🚀 LegalBridge Admin UI service started`);
  console.log(`   Admin UI route: /admin`);
  console.log(`   CSV一括発注UI: /admin/orders/csv`);
  console.log(`   Health: /health`);
  console.log(`   Readiness: /ready`);
  console.log(`   Runtime Status: /status`);
  console.log(`   Backlog Webhook route: /webhook/backlog`);
  updateLocalComponentStatus("http", {
    severity: "ok",
    detail: `Admin UI サービスがポート ${port} で稼働しています。`,
    success: true,
    meta: {
      port,
      endpoints: ["/health", "/ready", "/status", "/status.json", "/admin"],
    },
  });

  // Slack Bolt起動
  if (shouldStartSlackApp && slackApp) {
    try {
      await slackApp.start();
      console.log(`   Slack Bot: 常駐接続済み ✅`);
      updateLocalComponentStatus("slack", {
        severity: "ok",
        detail: "このサービスで Slack 常駐受付を有効にしています。",
        success: true,
      });
    } catch (error) {
      const detail = logStartupError("Slack 常駐受付 起動", error);
      updateLocalComponentStatus("slack", {
        severity: "warning",
        detail: `Slack 常駐受付を起動できませんでした。${detail}`,
        error: true,
      });
    }
  } else {
    console.log(`   Slack Bot: このサービスでは未接続（gateway 側で常駐受付）`);
  }

  // 支払期限アラートのスケジューラー起動
  if (enableBackgroundSync) {
    try {
      startScheduler(slackClient, {
        onStarted: ({ intervalHours }) => {
          updateLocalComponentStatus("scheduler", {
            severity: "ok",
            detail: `定期ジョブを ${intervalHours} 時間間隔で起動しました。`,
            success: true,
            meta: { intervalHours },
          });
        },
        onRunSuccess: (summary) => {
          updateLocalComponentStatus("scheduler", {
            severity: "ok",
            detail: "定期ジョブの実行が完了しました。",
            success: true,
            meta: summary,
          });
        },
        onRunError: (error) => {
          updateLocalComponentStatus("scheduler", {
            severity: "error",
            detail: error instanceof Error ? error.message : String(error),
            error: true,
          });
        },
      });
    } catch (error) {
      const detail = logStartupError("定期ジョブ 起動", error);
      updateLocalComponentStatus("scheduler", {
        severity: "error",
        detail,
        error: true,
      });
    }
  }

  // Backlogポーリング開始
  if (enableBackgroundSync) {
    try {
      startBacklogPolling(slackClient, {
        onStarted: ({ intervalSec }) => {
          updateLocalComponentStatus("poller", {
            severity: "ok",
            detail: `Backlog 同期ジョブを ${intervalSec} 秒間隔で起動しました。`,
            success: true,
            meta: { intervalSec },
          });
        },
        onRunSuccess: (summary) => {
          updateLocalComponentStatus("poller", {
            severity: summary.failedCount > 0 ? "warning" : "ok",
            detail: summary.failedCount > 0
              ? `Backlog 同期ジョブは完了しましたが、${summary.failedCount} 件の課題処理に失敗しました。`
              : "Backlog 同期ジョブの実行が完了しました。",
            success: summary.failedCount === 0,
            meta: summary,
          });
        },
        onRunError: (error) => {
          updateLocalComponentStatus("poller", {
            severity: "error",
            detail: error instanceof Error ? error.message : String(error),
            error: true,
          });
        },
      });
    } catch (error) {
      const detail = logStartupError("Backlog 同期ジョブ 起動", error);
      updateLocalComponentStatus("poller", {
        severity: "error",
        detail,
        error: true,
      });
    }
  }

  console.log(`\n📋 利用可能な導線:`);
  console.log(`   /法務依頼      - 依頼フォームを開く`);
  console.log(`   /法務ステータス LEGAL-XX - 案件の進捗確認`);
  console.log(`   /法務一覧      - 直近の案件一覧`);
  console.log(`\nℹ️  このサービスでは管理UIと補助 API を提供します。`);
  console.log(`   定期実行は work-service、Slack 常駐受付は gateway サービス側で処理します。\n`);
})().catch((error) => {
  const detail = logStartupError("Admin UI サービス起動", error);
  updateLocalComponentStatus("http", {
    severity: "error",
    detail,
    error: true,
  });
  process.exit(1);
});
