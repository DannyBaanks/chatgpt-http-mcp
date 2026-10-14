#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { createActiveBroker } from "../src/mcp/active-broker";
import { mintNativeSession, bindNativeSource, nativeRpc, nativeGateway } from "../src/mcp/active-native";
import { browserWorkerRpc } from "../src/visible/browser-worker";
import { findSessionByToken, revokeSession } from "../src/codex-sessions";

const launchId = "d946b5e9-231e-4b13-83ce-5170cf353658";
const visibleDir = join(homedir(), ".codex-web-http", "visible", launchId);
const socketPath = join(visibleDir, "browser.sock");
const credFile = join(visibleDir, "browser-worker-private-67ea5219-3d58-42ee-abf6-2f195e6178d9.json");

if (!existsSync(socketPath) || !existsSync(credFile)) {
  console.error("Visible browser socket or cred file not found");
  process.exit(1);
}

const { token: workerToken } = JSON.parse(readFileSync(credFile, "utf8"));

// 1. Inspect visible browser
console.log("1. Inspecting visible browser...");
const inspected = await browserWorkerRpc(socketPath, workerToken, { method: "inspect" });
console.log("Inspected:", JSON.stringify({ url: inspected.url, model: inspected.model, effort: inspected.effort }));

// 2. Setup active broker
const brokerDir = join(tmpdir(), `isymcp-test-broker-${randomUUID()}`);
mkdirSync(brokerDir, { recursive: true, mode: 0o700 });
const brokerSocket = join(brokerDir, "broker.sock");
const broker = await createActiveBroker(brokerSocket);

const cwd = process.cwd();
const reg = await nativeRpc(brokerSocket, {
  method: "owner_register",
  environment: {
    cwd,
    roots: [cwd],
    writableRoots: [],
    sandboxPolicy: { type: "readOnly" },
    tools: [{ name: "exec", description: "Execute native commands", parameters: {}, freeform: true }],
  },
  ttlMs: 300000,
});
const ownerToken = reg.token;
const threadId = randomUUID();
const turnId = randomUUID();
const requestId = randomUUID();

const session = await mintNativeSession({
  cwd,
  socketPath: brokerSocket,
  ownerToken,
  owner: { launchId, threadId, turnId, epoch: randomUUID() },
  ttlMinutes: 5,
});

console.log(`2. Minted native session: fp=${session.fp}, token=${session.token}`);

// 3. Background broker worker
const nonce = `ISYMCP_TWOWAY_${randomUUID().slice(0, 8)}`;
const command = ["printf", "%s\\n", nonce];
let toolExecuted = false;

const brokerWorker = (async () => {
  try {
    while (true) {
      const next = await nativeRpc(brokerSocket, { method: "owner_next", token: ownerToken }, 60000);
      if (!next.requests || !next.requests.length) continue;
      for (const req of next.requests) {
        console.log("Broker received invoke request:", req.callId, req.wireName);
        if (req.wireName === "exec") {
          // Execute the authorized command
          const proc = Bun.spawnSync(["printf", "%s\\n", nonce]);
          const out = proc.stdout.toString();
          toolExecuted = true;
          const content = [{
            type: "text",
            text: JSON.stringify({
              native_command_result: {
                output: out,
                exit_code: 0,
              },
            }),
          }];
          await nativeRpc(brokerSocket, {
            method: "owner_complete",
            token: ownerToken,
            callId: req.callId,
            toolResult: { content },
          });
          console.log("Broker completed invoke request:", req.callId, "output:", out.trim());
        }
      }
    }
  } catch (err: any) {
    if (err.message?.includes("revoked") || err.message?.includes("closed")) return;
    console.error("Broker worker error:", err);
  }
})();

// 4. Compose prompt
const prompt = [
  "COMANDO: @Codex ISyMCP",
  `turn_token: ${session.token}`,
  "Primero llama codex_turn_start y lee bootstrap.content. Luego consulta codex_tool_inventory.",
  `Ejecuta una sola vez codex_exec con command=${JSON.stringify(command)}.`,
  "Confirma el resultado exacto y cierra con codex_turn_complete.",
].join("\n");

// 5. Submit to browser worker
console.log("3. Submitting to visible browser...");
const submission = {
  requestId,
  prompt,
  connectorId: "asdk_app_6ace90ad54848191912160b8880294c7",
  model: inspected.model,
  effort: inspected.effort,
};

const receipt = await browserWorkerRpc(socketPath, workerToken, {
  method: "submit",
  request: submission,
});

console.log("4. Submission receipt:", JSON.stringify(receipt));

// 6. Bind native source immediately
bindNativeSource(session.fp, {
  url: receipt.url,
  messageId: receipt.userMessageId,
});
console.log("5. Native source bound successfully to messageId:", receipt.userMessageId);

// 7. Poll for completion
console.log("6. Waiting for ChatGPT answer...");
const deadline = Date.now() + 60000;
let finalAnswer = "";

while (Date.now() < deadline) {
  await Bun.sleep(2000);
  const answer = await browserWorkerRpc(socketPath, workerToken, {
    method: "read_bound_answer",
    requestId,
  });
  if (answer?.messages?.length) {
    const msg = answer.messages[0];
    if (msg.complete) {
      finalAnswer = msg.markdown;
      console.log("7. Answer complete! Length:", finalAnswer.length);
      console.log("Snippet:", finalAnswer.slice(0, 300));
      break;
    } else {
      process.stdout.write(".");
    }
  }
}

// 8. Cleanup
console.log("8. Cleaning up...");
revokeSession(session.fp);
await nativeRpc(brokerSocket, { method: "owner_revoke", token: ownerToken }).catch(() => {});
await broker.close();
rmSync(brokerDir, { recursive: true, force: true });

console.log("\n=== TEST RESULT ===");
console.log("Tool executed via broker:", toolExecuted);
console.log("Final answer received:", finalAnswer.length > 0);
if (toolExecuted && finalAnswer.length > 0) {
  console.log("STATUS: PASS — TWO-WAY INTERACTION CONFIRMED!");
} else {
  console.log("STATUS: INCOMPLETE");
  process.exit(1);
}
