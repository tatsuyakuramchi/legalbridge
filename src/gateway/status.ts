export interface GatewayRuntimeStatus {
  mode: "active" | "degraded";
  ready: boolean;
  warnings: string[];
  blockingIssues: string[];
  issueTypes?: Array<{
    requestType: string;
    backlogIssueTypeName: string;
    workflowKind: "primary" | "followup";
    status: "ok" | "missing";
  }>;
  fields?: Array<{
    envKey: string;
    label: string;
    requestType?: string;
    configuredValue?: string;
    status: "ok" | "missing_env" | "invalid_env" | "missing_in_backlog";
  }>;
  updatedAt: string;
}

export function createGatewayRuntimeStatus(input?: Partial<GatewayRuntimeStatus>): GatewayRuntimeStatus {
  return {
    mode: input?.mode ?? "active",
    ready: input?.ready ?? true,
    warnings: input?.warnings ?? [],
    blockingIssues: input?.blockingIssues ?? [],
    issueTypes: input?.issueTypes ?? [],
    fields: input?.fields ?? [],
    updatedAt: input?.updatedAt ?? new Date().toISOString(),
  };
}

export function renderGatewayStatusHtml(status: GatewayRuntimeStatus): string {
  const title = status.ready ? "Gateway Ready" : "Gateway Degraded";
  const tone = status.ready ? "#1f7a5a" : "#a04b00";
  const bg = status.ready ? "#eef8f3" : "#fff6eb";
  const warnings = status.warnings.length > 0
    ? status.warnings.map((item) => `<li>${escapeHtml(item)}</li>`).join("")
    : "<li>警告はありません。</li>";
  const blocking = status.blockingIssues.length > 0
    ? status.blockingIssues.map((item) => `<li>${escapeHtml(item)}</li>`).join("")
    : "<li>blocking issue はありません。</li>";
  const issueTypeRows = (status.issueTypes ?? []).length > 0
    ? (status.issueTypes ?? []).map((item) => `
      <tr>
        <td>${escapeHtml(item.requestType)}</td>
        <td>${escapeHtml(item.backlogIssueTypeName)}</td>
        <td>${escapeHtml(item.workflowKind)}</td>
        <td>${escapeHtml(item.status)}</td>
      </tr>`).join("")
    : `<tr><td colspan="4">課題タイプ情報はありません。</td></tr>`;
  const fieldRows = (status.fields ?? []).length > 0
    ? (status.fields ?? []).map((item) => `
      <tr>
        <td>${escapeHtml(item.requestType ?? "-")}</td>
        <td>${escapeHtml(item.label)}</td>
        <td><code>${escapeHtml(item.envKey)}</code></td>
        <td><code>${escapeHtml(item.configuredValue ?? "-")}</code></td>
        <td>${escapeHtml(item.status)}</td>
      </tr>`).join("")
    : `<tr><td colspan="5">属性情報はありません。</td></tr>`;

  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      --ink: #1f2933;
      --muted: #52606d;
      --line: #d9e2ec;
      --panel: #ffffff;
      --accent: ${tone};
      --accent-bg: ${bg};
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Hiragino Sans", "Yu Gothic UI", sans-serif;
      color: var(--ink);
      background: linear-gradient(180deg, #f8fafc 0%, #eef2f7 100%);
    }
    .wrap {
      max-width: 920px;
      margin: 0 auto;
      padding: 32px 20px 48px;
    }
    .hero, .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 20px;
      box-shadow: 0 12px 28px rgba(15, 23, 42, 0.06);
    }
    .hero {
      padding: 24px;
      margin-bottom: 18px;
      background: linear-gradient(180deg, var(--accent-bg) 0%, #fff 100%);
    }
    .eyebrow {
      color: var(--accent);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      margin-bottom: 8px;
    }
    h1 {
      margin: 0 0 10px;
      font-size: 32px;
      line-height: 1.15;
    }
    .meta {
      color: var(--muted);
      line-height: 1.7;
    }
    .chip-row {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 16px;
    }
    .chip {
      padding: 8px 12px;
      border-radius: 999px;
      background: rgba(255,255,255,0.9);
      border: 1px solid var(--line);
      font-size: 13px;
      font-weight: 700;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 18px;
    }
    .panel {
      padding: 20px;
    }
    h2 {
      margin: 0 0 12px;
      font-size: 18px;
    }
    ul {
      margin: 0;
      padding-left: 20px;
      line-height: 1.7;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    th, td {
      padding: 10px 8px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      vertical-align: top;
    }
    th {
      font-size: 12px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    code {
      background: #f1f5f9;
      padding: 2px 6px;
      border-radius: 8px;
      font-family: Consolas, monospace;
    }
  </style>
</head>
<body>
  <main class="wrap">
    <section class="hero">
      <div class="eyebrow">LegalBridge Gateway</div>
      <h1>${escapeHtml(title)}</h1>
      <div class="meta">
        Slack-Backlog 受付サービスの現在状態です。<br />
        更新時刻: <code>${escapeHtml(status.updatedAt)}</code>
      </div>
      <div class="chip-row">
        <div class="chip">mode: ${escapeHtml(status.mode)}</div>
        <div class="chip">ready: ${String(status.ready)}</div>
        <div class="chip">warnings: ${status.warnings.length}</div>
        <div class="chip">blocking: ${status.blockingIssues.length}</div>
      </div>
    </section>
    <section class="grid">
      <section class="panel">
        <h2>Blocking Issues</h2>
        <ul>${blocking}</ul>
      </section>
      <section class="panel">
        <h2>Warnings</h2>
        <ul>${warnings}</ul>
      </section>
    </section>
    <section class="panel" style="margin-top: 18px;">
      <h2>Issue Types</h2>
      <table>
        <thead>
          <tr>
            <th>Request Type</th>
            <th>Backlog Issue Type</th>
            <th>Workflow</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>${issueTypeRows}</tbody>
      </table>
    </section>
    <section class="panel" style="margin-top: 18px;">
      <h2>Field Resolution</h2>
      <table>
        <thead>
          <tr>
            <th>Request Type</th>
            <th>Label</th>
            <th>Env Key</th>
            <th>Configured</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>${fieldRows}</tbody>
      </table>
    </section>
  </main>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
