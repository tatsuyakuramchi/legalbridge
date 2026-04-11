type SlackPostMessageResult = {
  ok: boolean;
  ts?: string;
  skipped?: boolean;
  error?: string;
};

export type SlackMessageClient = {
  chat: {
    postMessage(message: any): Promise<SlackPostMessageResult>;
  };
};

const warnedMessages = new Set<string>();

function warnOnce(message: string): void {
  if (warnedMessages.has(message)) {
    return;
  }

  warnedMessages.add(message);
  console.warn(message);
}

export function createOptionalSlackClient(botToken?: string): SlackMessageClient {
  const token = String(botToken ?? "").trim();
  if (!token) {
    return {
      chat: {
        async postMessage(message: any): Promise<SlackPostMessageResult> {
          const channel = String(message?.channel ?? "").trim() || "unknown";
          warnOnce(`[Slack] 通知をスキップしました。SLACK_BOT_TOKEN 未設定: channel=${channel}`);
          return { ok: false, skipped: true };
        },
      },
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { WebClient } = require("@slack/web-api") as typeof import("@slack/web-api");
  const client = new WebClient(token);
  return {
    chat: {
      async postMessage(message: any): Promise<SlackPostMessageResult> {
        try {
          const response = await client.chat.postMessage(message);
          return {
            ok: Boolean(response.ok),
            ts: response.ts,
          };
        } catch (error) {
          const channel = String(message?.channel ?? "").trim() || "unknown";
          const reason = error instanceof Error ? error.message : String(error);
          warnOnce(`[Slack] 通知をスキップしました。channel=${channel} error=${reason}`);
          return {
            ok: false,
            skipped: true,
            error: reason,
          };
        }
      },
    },
  };
}
