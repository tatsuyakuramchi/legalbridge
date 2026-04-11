import axios from "axios";
import { google } from "googleapis";
import { WorkItem, summarizeWorkItem } from "./workItems";

export type WorkQueueMode = "inline" | "http" | "gcp-tasks" | "log-only";

export type EnqueueWorkResult = {
  accepted: true;
  executedInline: boolean;
  mode: WorkQueueMode;
};

function resolveWorkQueueMode(): WorkQueueMode {
  const raw = String(process.env.WORK_QUEUE_MODE ?? "inline").trim().toLowerCase();
  if (raw === "http") return "http";
  if (raw === "gcp-tasks") return "gcp-tasks";
  return raw === "log-only" ? "log-only" : "inline";
}

function resolveRequiredEnv(name: string): string {
  const value = String(process.env[name] ?? "").trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

async function enqueueViaCloudTasks(item: WorkItem): Promise<void> {
  const projectId = resolveRequiredEnv("GCP_PROJECT_ID");
  const location = resolveRequiredEnv("GCP_TASKS_LOCATION");
  const queueName = resolveRequiredEnv("GCP_TASKS_QUEUE");
  const workServiceUrl = resolveRequiredEnv("WORK_SERVICE_URL");
  const workServiceToken = resolveRequiredEnv("WORK_SERVICE_TOKEN");

  const parent = `projects/${projectId}/locations/${location}/queues/${queueName}`;
  const url = `https://cloudtasks.googleapis.com/v2/${parent}/tasks`;
  const payload = Buffer.from(JSON.stringify(item), "utf-8").toString("base64");

  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  const accessToken = await auth.getAccessToken();
  if (!accessToken) {
    throw new Error("Failed to obtain GCP access token for Cloud Tasks");
  }

  await axios.post(
    url,
    {
      task: {
        httpRequest: {
          httpMethod: "POST",
          url: `${workServiceUrl.replace(/\/$/, "")}/work-items`,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${workServiceToken}`,
          },
          body: payload,
        },
      },
    },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      timeout: 30_000,
    },
  );
}

export async function enqueueWork(
  item: WorkItem,
  input: { inline: () => Promise<void> },
): Promise<EnqueueWorkResult> {
  const mode = resolveWorkQueueMode();
  console.log(`[Queue] Enqueue ${summarizeWorkItem(item)} mode=${mode}`);

  if (mode === "inline") {
    await input.inline();
    return { accepted: true, executedInline: true, mode };
  }

  if (mode === "http") {
    const workServiceUrl = resolveRequiredEnv("WORK_SERVICE_URL");
    const workServiceToken = String(process.env.WORK_SERVICE_TOKEN ?? "").trim();
    await axios.post(`${workServiceUrl.replace(/\/$/, "")}/work-items`, item, {
      headers: {
        ...(workServiceToken ? { Authorization: `Bearer ${workServiceToken}` } : {}),
      },
      timeout: 30_000,
    });

    return { accepted: true, executedInline: false, mode };
  }

  if (mode === "gcp-tasks") {
    await enqueueViaCloudTasks(item);
    return { accepted: true, executedInline: false, mode };
  }

  console.warn(`[Queue] Deferred execution is not implemented yet. Accepted without execution: ${summarizeWorkItem(item)}`);
  return { accepted: true, executedInline: false, mode };
}
