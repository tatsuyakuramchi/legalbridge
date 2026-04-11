import dotenv from "dotenv";
dotenv.config();

import { backlog } from "../backlog/client";

type DesiredIssueType = {
  envKey: string;
  name: string;
  color: string;
};

const DESIRED_ISSUE_TYPES: DesiredIssueType[] = [
  {
    envKey: "BACKLOG_ISSUE_TYPE_PUBLISHING_ORDER",
    name: process.env.BACKLOG_ISSUE_TYPE_PUBLISHING_ORDER ?? "出版発注書",
    color: "#814fbc",
  },
  {
    envKey: "BACKLOG_ISSUE_TYPE_ROYALTY_SALES",
    name: process.env.BACKLOG_ISSUE_TYPE_ROYALTY_SALES ?? "売上報告案件",
    color: "#666665",
  },
];

async function main() {
  const issueTypes = await backlog.listIssueTypes();
  const issueTypeByName = new Map(issueTypes.map((item) => [item.name, item]));
  const results: Array<Record<string, unknown>> = [];

  for (const desired of DESIRED_ISSUE_TYPES) {
    const existing = issueTypeByName.get(desired.name);
    if (existing) {
      results.push({
        envKey: desired.envKey,
        name: desired.name,
        status: "exists",
        issueTypeId: existing.id,
      });
      continue;
    }

    const created = await backlog.addIssueType({
      name: desired.name,
      color: desired.color,
    });

    results.push({
      envKey: desired.envKey,
      name: desired.name,
      status: "created",
      issueTypeId: created.id,
    });
  }

  console.log(JSON.stringify({
    projectKey: process.env.BACKLOG_PROJECT_KEY ?? "",
    results,
  }, null, 2));
}

main().catch((error) => {
  console.error("[Backlog] 最小課題タイプの作成に失敗");
  if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error(String(error));
  }
  process.exit(1);
});
