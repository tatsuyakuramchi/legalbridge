import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { App } from "@slack/bolt";
import { createSlackGatewayApp } from "../slackGatewayApp";

const TEST_SIGNING_SECRET = "test-signing-secret";
const TEST_BOT_TOKEN = "xoxb-test-token";

test("Slack gateway rejects requests with invalid signature", async () => {
  const { httpApp } = createSlackGatewayApp({
    slackBotToken: TEST_BOT_TOKEN,
    slackSigningSecret: TEST_SIGNING_SECRET,
    tokenVerificationEnabled: false,
    registerHandlers: () => {},
  });

  const server = httpApp.listen(0);
  try {
    const body =
      "command=%2Ftest&text=hello&trigger_id=1337.42&user_id=U123&channel_id=C123&team_id=T123";
    const response = await postSlackCommand({
      server,
      body,
      timestamp: Math.floor(Date.now() / 1000).toString(),
      signature: "v0=invalid",
    });

    assert.equal(response.statusCode, 401);
  } finally {
    await closeServer(server);
  }
});

test("Slack gateway accepts requests with valid signature", async () => {
  let reached = false;
  const { httpApp } = createSlackGatewayApp({
    slackBotToken: "",
    slackSigningSecret: TEST_SIGNING_SECRET,
    authorize: async () => ({
      botToken: TEST_BOT_TOKEN,
      botId: "B123",
      botUserId: "U999",
    }),
    registerHandlers: (app: App) => {
      app.command("/test", async ({ ack }) => {
        reached = true;
        await ack();
      });
    },
  });

  const server = httpApp.listen(0);
  try {
    const body =
      "command=%2Ftest&text=hello&trigger_id=1337.42&user_id=U123&user_name=tester&channel_id=C123&channel_name=general&team_id=T123&team_domain=example&api_app_id=A123";
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = buildSlackSignature(TEST_SIGNING_SECRET, timestamp, body);

    const response = await postSlackCommand({
      server,
      body,
      timestamp,
      signature,
    });

    assert.equal(response.statusCode, 200);
    assert.equal(reached, true);
  } finally {
    await closeServer(server);
  }
});

function buildSlackSignature(signingSecret: string, timestamp: string, body: string): string {
  const hmac = crypto.createHmac("sha256", signingSecret);
  hmac.update(`v0:${timestamp}:${body}`);
  return `v0=${hmac.digest("hex")}`;
}

function postSlackCommand(input: {
  server: http.Server;
  body: string;
  timestamp: string;
  signature: string;
}): Promise<{ statusCode: number; body: string }> {
  const address = input.server.address();
  if (!address || typeof address === "string") {
    throw new Error("テストサーバーのアドレス取得に失敗しました。");
  }

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: address.port,
        path: "/slack/commands",
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "content-length": Buffer.byteLength(input.body),
          "x-slack-request-timestamp": input.timestamp,
          "x-slack-signature": input.signature,
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => {
          raw += chunk.toString();
        });
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            body: raw,
          });
        });
      }
    );

    req.on("error", reject);
    req.write(input.body);
    req.end();
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
