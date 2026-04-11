type LocalComponentKey =
  | "http"
  | "db"
  | "backlogConfig"
  | "slack"
  | "scheduler"
  | "poller";

type LocalComponentSeverity = "ok" | "warning" | "error" | "disabled" | "pending";

export interface LocalComponentStatus {
  key: LocalComponentKey;
  label: string;
  severity: LocalComponentSeverity;
  detail: string;
  updatedAt: string;
  lastSuccessAt?: string;
  lastErrorAt?: string;
  meta?: Record<string, unknown>;
}

export interface LocalRuntimeStatus {
  service: "local-app";
  mode: "active" | "degraded";
  ready: boolean;
  updatedAt: string;
  components: LocalComponentStatus[];
}

const COMPONENT_LABELS: Record<LocalComponentKey, string> = {
  http: "HTTP / Admin UI",
  db: "Database",
  backlogConfig: "Backlog Config",
  slack: "Slack Socket Mode",
  scheduler: "Scheduler",
  poller: "Backlog Poller",
};

const runtimeState = new Map<LocalComponentKey, LocalComponentStatus>(
  Object.entries(COMPONENT_LABELS).map(([key, label]) => [
    key as LocalComponentKey,
    {
      key: key as LocalComponentKey,
      label,
      severity: "pending",
      detail: "起動待ち",
      updatedAt: new Date().toISOString(),
    },
  ]),
);

export function updateLocalComponentStatus(
  key: LocalComponentKey,
  input: {
    severity: LocalComponentSeverity;
    detail: string;
    meta?: Record<string, unknown>;
    success?: boolean;
    error?: boolean;
  },
): void {
  const previous = runtimeState.get(key);
  const now = new Date().toISOString();
  runtimeState.set(key, {
    key,
    label: COMPONENT_LABELS[key],
    severity: input.severity,
    detail: input.detail,
    updatedAt: now,
    lastSuccessAt: input.success ? now : previous?.lastSuccessAt,
    lastErrorAt: input.error ? now : previous?.lastErrorAt,
    meta: input.meta,
  });
}

export function getLocalRuntimeStatus(): LocalRuntimeStatus {
  const components = Array.from(runtimeState.values());
  const hasBlockingError = components.some((component) => component.severity === "error");
  const hasPending = components.some((component) => component.severity === "pending");
  const mode = hasBlockingError || hasPending ? "degraded" : "active";
  const ready = !hasBlockingError && !hasPending;
  return {
    service: "local-app",
    mode,
    ready,
    updatedAt: new Date().toISOString(),
    components,
  };
}

export function renderLocalRuntimeStatusHtml(status: LocalRuntimeStatus): string {
  const componentCards = status.components.map((component) => `
    <section class="card">
      <div class="card-head">
        <strong>${escapeHtml(component.label)}</strong>
        <span class="badge badge-${component.severity}">${component.severity}</span>
      </div>
      <p>${escapeHtml(component.detail)}</p>
      <dl>
        <div><dt>updated</dt><dd>${escapeHtml(component.updatedAt)}</dd></div>
        <div><dt>last success</dt><dd>${escapeHtml(component.lastSuccessAt ?? "-")}</dd></div>
        <div><dt>last error</dt><dd>${escapeHtml(component.lastErrorAt ?? "-")}</dd></div>
      </dl>
      ${renderMeta(component.meta)}
    </section>
  `).join("");

  return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>LegalBridge Local Status</title>
    <style>
      :root {
        --bg: #f7f3ee;
        --panel: rgba(255, 251, 246, 0.94);
        --line: rgba(141, 111, 84, 0.16);
        --ink: #2a241f;
        --muted: #75695d;
        --accent: #2f7f73;
        --danger: #b42318;
        --warn: #b54708;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "Hiragino Sans", "Yu Gothic UI", "Yu Gothic", sans-serif;
        color: var(--ink);
        background:
          radial-gradient(circle at top left, rgba(217,143,112,0.12), transparent 24%),
          radial-gradient(circle at top right, rgba(47,127,115,0.12), transparent 28%),
          linear-gradient(180deg, #fcfaf6 0%, var(--bg) 100%);
      }
      .wrap {
        max-width: 1180px;
        margin: 0 auto;
        padding: 28px 20px 56px;
      }
      .hero, .card {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 24px;
        box-shadow: 0 18px 40px rgba(76, 57, 42, 0.08);
      }
      .hero {
        padding: 28px;
        margin-bottom: 20px;
      }
      h1 { margin: 0 0 8px; font-size: clamp(28px, 4vw, 40px); }
      .sub { color: var(--muted); line-height: 1.7; margin: 0; }
      .summary {
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
        margin-top: 16px;
      }
      .pill, .badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 8px 12px;
        border-radius: 999px;
        font-size: 12px;
        font-weight: 700;
      }
      .pill { background: rgba(47,127,115,0.1); color: var(--accent); }
      .pill-degraded { background: rgba(181,71,8,0.12); color: var(--warn); }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
        gap: 16px;
      }
      .card { padding: 20px; }
      .card-head {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: center;
      }
      .card p { color: var(--muted); line-height: 1.7; }
      dl { display: grid; gap: 8px; margin: 0; }
      dl div {
        display: grid;
        grid-template-columns: 100px 1fr;
        gap: 10px;
      }
      dt { color: var(--muted); }
      dd { margin: 0; word-break: break-word; }
      pre {
        overflow: auto;
        background: rgba(255,255,255,0.72);
        border: 1px solid var(--line);
        border-radius: 16px;
        padding: 12px;
        font-size: 12px;
        line-height: 1.6;
      }
      .badge-ok { background: rgba(47,127,115,0.12); color: var(--accent); }
      .badge-warning { background: rgba(181,71,8,0.12); color: var(--warn); }
      .badge-error { background: rgba(180,35,24,0.12); color: var(--danger); }
      .badge-disabled, .badge-pending { background: rgba(117,105,93,0.12); color: var(--muted); }
    </style>
  </head>
  <body>
    <main class="wrap">
      <section class="hero">
        <h1>LegalBridge Local Runtime</h1>
        <p class="sub">Local UI / Worker / DB の現在状態を表示します。運用時は <code>/ready</code> で可否、<code>/status.json</code> で構造化情報を確認できます。</p>
        <div class="summary">
          <span class="pill ${status.mode === "degraded" ? "pill-degraded" : ""}">mode: ${status.mode}</span>
          <span class="pill ${status.ready ? "" : "pill-degraded"}">ready: ${String(status.ready)}</span>
          <span class="pill">updated: ${escapeHtml(status.updatedAt)}</span>
        </div>
      </section>
      <section class="grid">${componentCards}</section>
    </main>
  </body>
</html>`;
}

function renderMeta(meta?: Record<string, unknown>): string {
  if (!meta || Object.keys(meta).length === 0) {
    return "";
  }
  return `<pre>${escapeHtml(JSON.stringify(meta, null, 2))}</pre>`;
}

function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
