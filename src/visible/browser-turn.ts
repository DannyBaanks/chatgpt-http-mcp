// src/visible/browser-turn.ts — Adapter de envío para el navegador Chrome visible.
// Permite que runTaskTurn y el bridge de Responses utilicen el navegador visible
// autenticado en lugar del navegador headless cuando esté disponible.
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { browserWorkerRpc } from "./browser-worker";
import { bindNativeSource } from "../mcp/active-native";
import { findSessionByToken } from "../codex-sessions";
import type { WebTurnOptions, WebTurnResult } from "../web-turn";

export interface ActiveVisibleSession {
  launchId: string;
  directory: string;
  socketPath: string;
  token: string;
  inspected: {
    url: string;
    connectorId: string;
    model: string;
    effort: string;
  };
}

export const KNOWN_CONNECTOR_ID = "asdk_app_6ace90ad54848191912160b8880294c7";

export function visibleSessionsRoot(): string {
  if (process.env.ISYMCP_VISIBLE_ROOT) return process.env.ISYMCP_VISIBLE_ROOT;
  return join(process.env.HOME ?? homedir(), ".codex-web-http", "visible");
}

/**
 * Localiza la sesión visible activa más reciente en ~/.codex-web-http/visible/.
 * Valida la existencia del socket y la autorización mediante un inspect rápido.
 */
export async function findActiveVisibleSession(root = visibleSessionsRoot()): Promise<ActiveVisibleSession | null> {
  const visibleRoot = root;
  if (!existsSync(visibleRoot)) return null;

  const entries = readdirSync(visibleRoot);
  for (const name of entries) {
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(name)) continue;
    const directory = join(visibleRoot, name);
    const socketPath = join(directory, "browser.sock");
    if (!existsSync(socketPath)) continue;

    try {
      const stat = lstatSync(socketPath);
      if (!stat.isSocket()) continue;
    } catch {
      continue;
    }

    const files = readdirSync(directory);
    const credFiles = files
      .filter((f) => f.startsWith("browser-worker-private-") && f.endsWith(".json"))
      .map((f) => {
        try {
          return { name: f, mtime: statSync(join(directory, f)).mtimeMs };
        } catch {
          return { name: f, mtime: 0 };
        }
      })
      .sort((a, b) => b.mtime - a.mtime);

    for (const credEntry of credFiles) {
      try {
        const credText = readFileSync(join(directory, credEntry.name), "utf8");
        const cred = JSON.parse(credText);
        if (!cred.token || typeof cred.token !== "string") continue;

        const inspected = await browserWorkerRpc(socketPath, cred.token, { method: "inspect" });
        if (inspected && typeof inspected.url === "string" && inspected.model) {
          return {
            launchId: name,
            directory,
            socketPath,
            token: cred.token,
            inspected,
          };
        }
      } catch {
        continue;
      }
    }
  }

  return null;
}

/**
 * Ejecuta un turno web visible en el Chrome del usuario mediante browserWorkerRpc.
 * Cumple la firma requerida por runTaskTurn en task-turn.ts (deps.send).
 */
export async function sendVisibleWebTurn(prompt: string, options: WebTurnOptions = {}, root?: string): Promise<WebTurnResult> {
  const session = await findActiveVisibleSession(root);
  if (!session) {
    throw new Error("visible_browser_not_running: no active visible Chrome host found in ~/.codex-web-http/visible/");
  }

  const started = Date.now();
  const requestId = randomUUID();
  const connectorId = KNOWN_CONNECTOR_ID;
  const model = session.inspected.model || "GPT-6";
  const effort = session.inspected.effort || "medium";

  // Preflight hook
  if (options.beforeSubmit) {
    await options.beforeSubmit({
      url: () => session.inspected.url,
    } as any);
  }

  // Notificar intento inminente de envío
  options.onSubmitAttempt?.();

  // Enviar a través del worker del navegador visible
  const receipt = await browserWorkerRpc(session.socketPath, session.token, {
    method: "submit",
    request: {
      requestId,
      prompt,
      connectorId,
      model,
      effort,
    },
  });

  // Si el prompt incluye un turn_token activo de una sesión nativa, enlazar el origen inmediatamente
  const matchToken = /turn_token:\s*([a-zA-Z0-9_-]+)/.exec(prompt);
  if (matchToken) {
    const nativeSess = findSessionByToken(matchToken[1]);
    if (nativeSess && nativeSess.nativeOwner && nativeSess.nativeOwner.phase === "prepared") {
      try {
        bindNativeSource(nativeSess.fp, {
          url: receipt.url,
          messageId: receipt.userMessageId,
        });
      } catch (err) {
        console.error("sendVisibleWebTurn: error binding native source:", err);
      }
    }
  }

  // Esperar la respuesta en el DOM de ChatGPT
  const deadline = Date.now() + (options.deadlineMs ?? 120_000);
  let finalMarkdown = "";

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    const answer = await browserWorkerRpc(session.socketPath, session.token, {
      method: "read_bound_answer",
      requestId,
    });

    if (answer?.messages?.length) {
      const msg = answer.messages[0];
      if (typeof msg.markdown === "string") {
        options.onProgress?.(msg.markdown);
      }
      if (msg.complete) {
        finalMarkdown = msg.markdown;
        break;
      }
    }
  }

  if (!finalMarkdown) {
    throw new Error("visible_turn_timeout: ChatGPT did not complete the answer within deadline");
  }

  return {
    text: finalMarkdown,
    ms: Date.now() - started,
    submitted: true,
    reused: true,
    url: receipt.url,
    markdown: finalMarkdown,
  };
}
