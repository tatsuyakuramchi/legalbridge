import express from "express";
import { createOptionalSlackClient } from "../slack/optionalClient";
import { executeWorkItem } from "../queue/executor";
import { WorkItem } from "../queue/workItems";
import { runSchedulerOnce } from "../db/scheduler";
import { runBacklogPollingOnce } from "../backlog/poller";

function isWorkItem(value: unknown): value is WorkItem {
  if (!value || typeof value !== "object") {
    return false;
  }

  const item = value as Partial<WorkItem>;
  if (item.type !== "generate-documents") {
    return false;
  }

  return (
    typeof item.issueKey === "string"
    && typeof item.issueTypeName === "string"
    && typeof item.source === "string"
    && !!item.content
    && typeof item.content === "object"
  );
}

function isAuthorized(req: express.Request): boolean {
  const expectedToken = String(process.env.WORK_SERVICE_TOKEN ?? "").trim();
  if (!expectedToken) {
    return true;
  }

  const authHeader = String(req.header("authorization") ?? "");
  return authHeader === `Bearer ${expectedToken}`;
}

export function createWorkApp(): express.Express {
  const app = express();
  const slack = createOptionalSlackClient(process.env.SLACK_BOT_TOKEN);

  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.status(200).json({
      status: "ok",
      service: "work-service",
      ready: true,
    });
  });

  app.get("/ready", (_req, res) => {
    res.status(200).json({
      ready: true,
      service: "work-service",
    });
  });

  app.post("/work-items", async (req, res) => {
    if (!isAuthorized(req)) {
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }

    if (!isWorkItem(req.body)) {
      res.status(400).json({ ok: false, error: "Invalid work item payload" });
      return;
    }

    try {
      const result = await executeWorkItem(req.body, { slack });
      res.status(202).json({
        ok: true,
        accepted: true,
        executed: result.status === "executed",
        skipped: result.status === "skipped",
        skipReason: result.status === "skipped" ? result.reason : null,
        executionKey: result.executionKey,
        type: req.body.type,
        issueKey: req.body.issueKey,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post("/jobs/scheduler", async (req, res) => {
    if (!isAuthorized(req)) {
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }

    try {
      const summary = await runSchedulerOnce(slack);
      res.status(200).json({
        ok: true,
        job: "scheduler",
        summary,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        job: "scheduler",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post("/jobs/backlog-poller", async (req, res) => {
    if (!isAuthorized(req)) {
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }

    try {
      const summary = await runBacklogPollingOnce(slack);
      res.status(200).json({
        ok: true,
        job: "backlog-poller",
        summary,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        job: "backlog-poller",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return app;
}
