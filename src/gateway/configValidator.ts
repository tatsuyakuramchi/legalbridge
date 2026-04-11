const REQUIRED_GATEWAY_ENV = [
  "SLACK_BOT_TOKEN",
  "SLACK_SIGNING_SECRET",
  "BACKLOG_API_KEY",
  "BACKLOG_SPACE",
  "BACKLOG_PROJECT_KEY",
];

export function validateGatewayConfiguration(): void {
  const missing = REQUIRED_GATEWAY_ENV.filter((key) => !String(process.env[key] ?? "").trim());
  if (missing.length === 0) {
    console.log("[GatewayConfig] 起動前チェックOK: Slack-Backlog 受付サービスの必須設定を確認しました。");
    return;
  }

  throw new Error(`Slack-Backlog 受付サービスの環境変数が未設定です: ${missing.join(", ")}`);
}
