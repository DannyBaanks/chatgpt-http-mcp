// src/cli/commands/codex.ts — `isymcp codex|conversation|models|command|session`.
import { installWebModels } from "../../../scripts/install-web-models";
import { flag } from "../../cli/args";
import { buildCodexArgs, installDesktopLauncher, isBridgeAlive, removeDesktopLauncher, usesWebBridge } from "../../codex-launcher";
import { isExpired, listUserSessions, mintSession, revokeSession } from "../../codex-sessions";
import { bridgeToken } from "../../local-guard";
import { buildChatGPTCommand, CONNECTOR_NAME, MENTION } from "../../mcp/identity";
import { findCodexWindowsCli } from "../../platform/codex-windows-sandbox";
import { bindCookies } from "../../sessions";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BRIDGE, PORT, startServer } from "../services";
import { status } from "./status";
import type { CliModule } from "../module";

export function guardarSesion(name: string): void {
  const source = join(homedir(), ".codex-web-http", "storage-state.json");
  const record = bindCookies(name, source);
  console.log(`sesion ${record.name}: cookies en ${record.statePath}`);
  console.log(`conversacion: ${record.conversationUrl ?? "(aun no hay /c/, el primer turno la guarda)"}`);
}

// session mint|list|revoke — capacidades del MCP nativo (Codex ISyMCP).
// Read-only por defecto; --write habilita apply_patch y escrituras sandbox.
export function codexSession(sub: string, rest: string[]): void {
  const opt = (name: string): string | undefined => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  if (sub === "mint") {
    const cwd = opt("--cwd") ?? process.cwd();
    const label = opt("--label");
    const writable = rest.includes("--write") || rest.includes("--writable") || rest.includes("--rw");
    const ttlRaw = opt("--ttl");
    const ttlHours = ttlRaw === undefined ? undefined : Number(ttlRaw);
    const requestFile = opt("--request-file");
    if (rest.includes("--request-file") && (!requestFile || requestFile.startsWith("--")))
      throw new Error("--request-file requiere un archivo de texto dentro del workspace");
    const record = mintSession(cwd, { label, writable, ttlHours, requestFile });
    console.log("sesion Codex ISyMCP creada (el token se muestra UNA vez; el registro es 0600)");
    console.log(`  label:    ${record.label}`);
    console.log(`  cwd:      ${record.cwd}`);
    console.log(`  writable: ${record.writable}`);
    console.log(`  fp:       ${record.fp}`);
    console.log(`  caduca:   ${record.expiresAt ?? "nunca (--ttl 0)"}`);
    if (record.request) console.log(`  request:  ${record.request.filename} [sha256 ${record.request.sha256}]`);
    console.log(`  token:    ${record.token}`);
    console.log("");
    console.log("Para usarla, elegir el app Codex ISyMCP en el composer y pegar:");
    console.log("  COMANDO: @CODEX ISYMCP");
    console.log(`  turn_token: ${record.token}`);
    console.log("  Primero llama codex_turn_start y lee bootstrap.content.");
    console.log(record.request ? "  Ejecuta la tarea local verificada de request.content y devuelve evidencia real." :
      "  Solicitud: <escribe aquí tu tarea autorizada>.");
    return;
  }
  if (sub === "list") {
    const sessions = listUserSessions();
    for (const s of sessions) {
      const expiry = !s.expiresAt ? "sin-caducidad" : isExpired(s) ? "CADUCADA" : `caduca ${s.expiresAt}`;
      console.log(`${s.createdAt} ${s.writable ? "rw" : "ro"} ${s.cwd} (${s.label}) [${s.fp}] ${expiry}`);
    }
    console.log(`Sessions: ${sessions.length}`);
    return;
  }
  if (sub === "revoke") {
    const target = rest.find((a) => !a.startsWith("--"));
    if (!target) throw new Error("uso: isymcp session revoke <token|fp>");
    console.log(`Revoked sessions: ${revokeSession(target)}`);
    return;
  }
  throw new Error("uso: isymcp session mint --cwd <dir> [--label x] [--write] [--ttl horas] [--request-file TASK.md] | list | revoke <token|fp>");
}

export function modelsRestore(): void {
  const result = installWebModels({ restore: true });
  console.log(JSON.stringify(result, null, 2));
}

export function installIntoCodex(apply: boolean): void {
  const result = installWebModels({
    apply,
    restore: false,
    url: `${BRIDGE}/v1`,
    caps: process.env.CODEX_WEB_HTTP_CAPS,
    model: apply ? "chatgpt-web/gpt-5.6-sol" : undefined,
    effort: apply ? "high" : undefined,
  });
  console.log(JSON.stringify(result, null, 2));
  if (!apply) {
    console.log("(dry-run: no escribio. Modelos → Preparar perfil crea archivos privados de ISyMCP)");
    return;
  }
  console.log("perfil Web preparado: isymcp codex lo activa solo en ese proceso");
  console.log("configuracion y catalogo global de Codex conservados");
}

export function command(text: string, effort?: string): void {
  console.log(`# app: ${CONNECTOR_NAME}`);
  console.log(`# token: ${MENTION}\n`);
  console.log("--- INICIO DEL TEXTO A PEGAR ---");
  console.log(buildChatGPTCommand(text, { effort }));
  console.log("--- FIN ---");
}

export function spawnCodex(args: string[], extraEnv: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve) => {
    const env = { ...process.env, ...extraEnv };
    const executable = process.platform === "win32" ? findCodexWindowsCli(env) : "codex";
    if (!executable) {
      console.error("no se pudo iniciar Codex: falta codex.exe; instala @openai/codex o define ISYMCP_CODEX_CLI_BIN");
      resolve(1);
      return;
    }
    const child = spawn(executable, args, { stdio: "inherit", env });
    child.once("error", (error) => { console.error(`no se pudo iniciar Codex: ${error.message}`); resolve(1); });
    child.once("exit", (status, signal) => resolve(status ?? (signal ? 1 : 0)));
  });
}

export async function ensureWebBridge(): Promise<void> {
  if (await isBridgeAlive(PORT)) return;
  console.log(`[isymcp] Bridge local apagado en http://127.0.0.1:${PORT}. Iniciando...`);
  startServer();
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await isBridgeAlive(PORT)) return;
  }
  throw new Error(`bridge Web no disponible o no autorizado en ${BRIDGE}; no se inicio Codex`);
}

export function commandPositionals(args: string[]): string[] {
  const valued = new Set(["--client", "--cwd", "--model"]);
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (valued.has(arg)) { i += 1; continue; }
    if (!arg.startsWith("--")) out.push(arg);
  }
  return out;
}

export async function conversationCommand(sub: string | undefined, rest: string[]): Promise<void> {
  const {
    conversationsDir, findConversation, listConversations, planNewConversation, planResumeConversation, writeLaunchIntent,
  } = await import("../../codex-conversation");
  const dir = conversationsDir();
  if (sub === "list") {
    const rows = listConversations(dir);
    if (!rows.length) console.log("sin conversaciones confirmadas");
    for (const row of rows) console.log(`${row.launchId}\t${row.threadId}\t${row.model}\t${row.cwd}\t${row.url}`);
    return;
  }
  if (sub === "new") {
    const client = flag("--client", rest) ?? "cli";
    const cwd = flag("--cwd", rest) ?? process.cwd();
    const model = flag("--model", rest) ?? "chatgpt-web/gpt-5.6-sol";
    if (client !== "cli") throw new Error("web_conversation_client_unsupported: isolated Desktop App profiles are UNKNOWN / NO EXECUTE; use --client cli");
    const plan = planNewConversation({ client, cwd, model });
    if (!existsSync(cwd)) throw new Error(`web_conversation_cwd_invalid: no existe ${cwd}`);
    writeLaunchIntent(dir, plan.intent);
    await ensureWebBridge();
    const profile = installWebModels({ apply: true, url: `${BRIDGE}/v1`, model, effort: "high", caps: process.env.CODEX_WEB_HTTP_CAPS });
    const code = await spawnCodex(plan.args({ port: PORT, catalogPath: profile.catalogReady ? profile.catalogPath : undefined }), plan.env);
    if (code !== 0) process.exitCode = code;
    return;
  }
  if (sub === "resume") {
    const id = commandPositionals(rest)[0];
    if (!id) throw new Error("uso: isymcp conversation resume <launch-id|thread-id>");
    const receipt = findConversation(dir, id);
    if (receipt.client !== "cli") throw new Error("web_conversation_resume_invalid: only a committed CLI receipt can resume");
    await ensureWebBridge();
    const profile = installWebModels({
      apply: true, url: `${BRIDGE}/v1`, model: receipt.model, effort: receipt.effort, caps: process.env.CODEX_WEB_HTTP_CAPS,
    });
    const args = planResumeConversation(receipt, { port: PORT, catalogPath: profile.catalogReady ? profile.catalogPath : undefined });
    const code = await spawnCodex(args, { ISYMCP_LAUNCH_ID: receipt.launchId });
    if (code !== 0) process.exitCode = code;
    return;
  }
  throw new Error("uso: isymcp conversation new [--client cli] [--cwd dir] [--model alias] | list | resume <launch-id|thread-id>");
}

export async function codexCommand(sub: string | undefined, rest: string[]): Promise<void> {
  if (sub === "launcher" || sub === "desktop") {
    if (rest.includes("--remove") || rest.includes("remove") || rest.includes("uninstall")) {
      const res = removeDesktopLauncher();
      console.log(`Lanzador removido: bin=${res.removedBin} desktop=${res.removedDesktop}`);
    } else {
      const res = installDesktopLauncher();
      console.log(`Lanzador instalado con éxito:`);
      console.log(`  CLI Wrapper: [32m${res.binPath}[0m`);
      console.log(`  Desktop Entry: [32m${res.desktopPath}[0m`);
      console.log(`Ahora puedes ejecutar 'codex-isymcp' o abrir 'Codex (ISyMCP Web)' desde tu menú.`);
    }
    return;
  }

  const userArgs = [sub, ...rest].filter((p): p is string => Boolean(p));
  let catalogPath: string | undefined;
  if (usesWebBridge(userArgs)) {
    if (!(await isBridgeAlive(PORT))) {
    console.log(`[isymcp] Bridge local apagado en http://127.0.0.1:${PORT}. Iniciando...`);
    startServer();
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await isBridgeAlive(PORT)) break;
    }
    }
    if (!(await isBridgeAlive(PORT))) {
      console.error(`bridge Web no disponible o no autorizado en ${BRIDGE}; no se inicio Codex`);
      process.exitCode = 1;
      return;
    }
    const profile = installWebModels({ apply: true, url: `${BRIDGE}/v1` });
    if (profile.catalogReady) catalogPath = profile.catalogPath;
  }
  const fullArgs = buildCodexArgs(userArgs, PORT, catalogPath);
  // El perfil aislado manda x-isymcp-token desde CODEX_WEB_HTTP_TOKEN.
  const code = await spawnCodex(fullArgs, usesWebBridge(userArgs) ? { CODEX_WEB_HTTP_TOKEN: bridgeToken() } : {});
  // La invocacion desde el menu vuelve al menu; no termina todo isymcp.
  if (code !== 0) process.exitCode = code;
}

export const codexModule: CliModule = { names: ["codex"], run: (sub, rest) => codexCommand(sub, rest) };

export const conversationModule: CliModule = { names: ["conversation"], run: (sub, rest) => conversationCommand(sub, rest) };

export const modelsModule: CliModule = {
  names: ["models"],
  async run(sub) {
    if (sub === "restore") modelsRestore();
    else if (sub === "apply") installIntoCodex(true);
    else installIntoCodex(false);
  },
};

export const commandModule: CliModule = {
  names: ["command"],
  async run(sub, rest, ctx) {
    if (!sub) { ctx.help(); process.exit(2); }
    const effortFlag = rest.includes("--effort") ? rest[rest.indexOf("--effort") + 1] : undefined;
    command([sub, ...rest.filter((a) => a !== "--effort" && a !== effortFlag)].join(" "), effortFlag);
  },
};

export const sessionModule: CliModule = {
  names: ["session"],
  async run(sub, rest) {
    if (sub === "mint" || sub === "list" || sub === "revoke") {
      try {
        codexSession(sub, rest);
      } catch (err) {
        console.error(String(err instanceof Error ? err.message : err));
        process.exit(2);
      }
    } else {
      guardarSesion(sub || "default");
    }
  },
};
