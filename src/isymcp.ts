#!/usr/bin/env bun
import { buildCodexArgs, installDesktopLauncher, isBridgeAlive, removeDesktopLauncher, usesWebBridge } from "./codex-launcher";
// isymcp — consola del bridge, y la UNICA entrada: en una terminal, `isymcp`
// a secas abre el menu con todo (panel, chat, ajustes, harnesses, canario...).
// Se puede cerrar: server y panel quedan detached.
//
//   isymcp                 menu (en TTY) / estado (sin TTY)
//   isymcp panel           abre el panel (lo levanta en background si hace falta)
//   isymcp ask "texto"     turno real con ChatGPT desde la terminal
//   isymcp up              server + tunel, en background
//   isymcp down            para server y tunel
//   isymcp server start|stop
//   isymcp tunnel connect|stop|status
//   isymcp models          dry-run del catalogo
//   isymcp models apply
//   isymcp models restore
//   isymcp command "texto"
import { spawn } from "node:child_process";
import readline from "node:readline";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { bindCookies } from "./sessions";
import { bridgeHome, isExpired, listUserSessions, mintSession, revokeSession } from "./codex-sessions";
import { assertExclusiveTunnel, configuredTunnelAlias, tunnelClientPath } from "./tunnel-routing";
import { startPanel } from "./panel";
import { createChat, loadChat } from "./chats";
import { runHook } from "./hooks";
import { installWebModels } from "../scripts/install-web-models";
import { defaultExportPath, exportLines, formatLine, parseBound, readAll, selectLines } from "./logs";
import { MENU, brandHeader, findItem, select, visible, visibleLabels } from "./menu";
import { buildChatGPTCommand, CONNECTOR_NAME, MENTION } from "./mcp/identity";
import { bridgeAuthHeaders, bridgeToken } from "./local-guard";
import { processMatches, stopProcessTree } from "./platform/process";
import { findCodexWindowsCli } from "./platform/codex-windows-sandbox";
import { installTunnelClient, storeRuntimeKey, storeTunnelId, validateRuntimeKey, validateTunnelId } from "../scripts/install-tunnel";
import { nativeBrowserCommand, parseBrowserOption, rejectUnavailableBrowser } from "./visible/native-browser";
import { ask, confirm, flag } from "./cli/args";
import { findCliModule } from "./cli/module";
import { PANEL_PORT, PANEL_URL, openPanel, panelUp, serverUp, sh, startPanelDetached, startServer, stopPanel, stopServer, tunnel } from "./cli/services";
import { help } from "./cli/help";
import { CLI_CHAT, askChatGPT } from "./cli/commands/chat";
import { settingsSync, settingsVerify } from "./cli/commands/settings";
import { canaryCommand, canaryScheduleInteractive } from "./cli/commands/canary";
import { codexCommand, codexSession, command, conversationCommand, guardarSesion, installIntoCodex, modelsRestore } from "./cli/commands/codex";
import { menuSession, status } from "./cli/commands/status";
import { logs } from "./cli/commands/logs";
import { tunnelSetup } from "./cli/commands/lifecycle";
import { healthCommand, metricsCommand, smokeCommand } from "./cli/commands/diagnostics";
import { monitorCommand } from "./cli/commands/monitor";
import { harnessCommand, harnessInteractive } from "./cli/commands/harness";

const ROOT = join(import.meta.dir, "..");







// ── Panel en background ────────────────────────────────────────────────────
// Mismo patron que el server: proceso detached + pid file. `isymcp panel`
// lo levanta si hace falta y abre el navegador; cerrar la terminal no lo mata.




// ── Monitor residente en background (GOAL-002) ─────────────────────────────
// Demonio continuo (`while (!stopped)` / `setInterval`) que NO se cierra aunque
// lleguen tareas o terminen respuestas; corre indefinidamente hasta `isymcp monitor stop`.






// ── Chat desde la terminal ─────────────────────────────────────────────────
// Usa el MISMO camino que el panel (POST /isymcp/chat/turn): un chat local =
// una conversacion real de chatgpt.com. El chat de la terminal se recuerda en
// run/cli-chat para que preguntas seguidas tengan contexto; --new empieza otro.




// ── Ajustes de ChatGPT (modelo/reasoning de la cuenta) ─────────────────────





// ── Confirmaciones del menu ────────────────────────────────────────────────


















// Una entrada por hoja visible del menu (tests/menu.test.ts lo exige).
const ACTIONS: Record<string, () => Promise<void> | void> = {
  "up": async () => {
    startServer();
    await new Promise((r) => setTimeout(r, 800));
    console.log(`health: ${(await serverUp()) ? "ok" : "aun no responde"}`);
    tunnel("connect");
    guardarSesion("default");
  },
  "down": () => { tunnel("stop"); stopServer(); },
  "restart": () => { tunnel("stop"); stopServer(); startServer(); tunnel("connect"); },
  "status": () => status(),
  "doctor": async () => {
    const { runDoctor, formatDoctor } = await import("./doctor");
    const report = runDoctor();
    console.log(formatDoctor(report));
    const { explainReport, defaultExplainRunner } = await import("./doctor-explain");
    const runner = defaultExplainRunner();
    if (runner) {
      const text = await explainReport(report, runner);
      if (text) console.log(`\nexplicacion (modelo local; no se ejecuta nada de lo que proponga)\n  ${text.replace(/\n/g, "\n  ")}`);
    }
    if (!report.ok) process.exitCode = 1;
  },
  "panel-open": () => openPanel(),
  "panel-start": async () => { await startPanelDetached(); },
  "panel-stop": () => stopPanel(),
  "ask": async () => {
    const text = await ask("pregunta (vacio = cancelar): ");
    if (!text) return;
    const fresh = existsSync(CLI_CHAT) ? !(await confirm("¿Seguir en el mismo chat de la terminal?")) : true;
    await askChatGPT(text, fresh);
  },
  "command": async () => {
    const text = await ask("texto de la tarea: ");
    const effort = await ask("effort [high]: ") || "high";
    if (text) command(text, effort);
  },
  "media-prepare": async () => {
    const { mediaCommand } = await import("./media/cli");
    await mediaCommand("prepare", []);
  },
  "conversation-new": async () => {
    const client = (await ask("cliente [cli]: ")) || "cli";
    const cwd = (await ask(`workspace (${process.cwd()}): `)) || process.cwd();
    const model = (await ask("modelo [chatgpt-web/gpt-5.6-sol]: ")) || "chatgpt-web/gpt-5.6-sol";
    await conversationCommand("new", ["--client", client, "--cwd", cwd, "--model", model]);
  },
  "settings-verify": () => settingsVerify(),
  "settings-sync": () => settingsSync(),
  "harness-list": () => harnessCommand("list", []),
  "harness-install": () => harnessInteractive("install"),
  "harness-uninstall": () => harnessInteractive("uninstall"),
  "canary-run": () => canaryCommand("run", []),
  "canary-status": () => canaryCommand("status", []),
  "canary-schedule": () => canaryScheduleInteractive("schedule"),
  "canary-unschedule": () => canaryScheduleInteractive("unschedule"),
  "server-start": () => startServer(),
  "server-stop": () => stopServer(),
  "tunnel-setup": () => tunnelSetup(),
  "tunnel-connect": () => tunnel("connect"),
  "tunnel-stop": () => tunnel("stop"),
  "tunnel-status": () => tunnel("status"),
  "logs-50": () => logs(["--last", "50"]),
  "logs-20": () => logs(["--last", "20"]),
  "logs-all": () => logs(["export", "--all"]),
  "logs-window": async () => {
    const since = await ask("desde (2026-10-02T16:00): ");
    const until = await ask("hasta (2026-10-02T17:00): ");
    logs(["export", "--since", since, "--until", until]);
  },
  "models-dry": () => installIntoCodex(false),
  "models-apply": () => installIntoCodex(true),
  "models-restore": () => modelsRestore(),
  "session-list": () => menuSession("list", []),
  "session-mint": async () => {
    const cwd = (await ask(`cwd (${process.cwd()}): `)) || process.cwd();
    const label = await ask("label (ej: mi-proyecto): ");
    await menuSession("mint", ["--cwd", cwd, ...(label ? ["--label", label] : [])]);
  },
  "session-mint-write": async () => {
    const cwd = (await ask(`cwd (${process.cwd()}): `)) || process.cwd();
    if (!(await confirm(`ChatGPT podra ESCRIBIR en ${cwd} (sandbox, 24 h). ¿Seguro?`))) return;
    const label = await ask("label (ej: mi-proyecto): ");
    await menuSession("mint", ["--cwd", cwd, "--write", ...(label ? ["--label", label] : [])]);
  },
  "session-revoke": async () => {
    const target = await ask("token o fingerprint: ");
    if (target) await menuSession("revoke", [target]);
  },
  "session-cookies": () => guardarSesion("default"),
  "github-status": async () => { await (await import("./github/cli")).githubCommand("status"); },
  "github-tokens-wizard": async () => { await (await import("./github/cli")).githubCommand("tokens", ["wizard"]); },
  "github-tokens-list": async () => { await (await import("./github/cli")).githubCommand("tokens", ["list"]); },
  "github-repos": async () => { await (await import("./github/cli")).githubCommand("repos"); },
};

async function runAction(id: string): Promise<void> {
  const action = ACTIONS[id];
  if (!action) {
    console.error(`accion sin implementar: ${id}`);
    return;
  }
  await runHook(`before:${id}`);
  await action();
  await runHook(`after:${id}`);
}

async function openMenu(items = visible(MENU), title = "¿Qué hacemos?"): Promise<void> {
  for (;;) {
    const index = await select(title, items);
    if (index < 0) {
      console.log("nos vemos :p");
      return;
    }
    const item = items[index];
    if (!item || item.id === "quit") {
      console.log("nos vemos :p");
      return;
    }
    console.log("");
    if (item.children) {
      await openMenu(visible(item.children), item.label);
      continue;
    }
    try {
      await runAction(item.id);
    } catch (error) {
      console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
    }
    console.log("");
  }
}

const [cmd, sub, ...rest] = process.argv.slice(2);

if (!cmd && process.stdin.isTTY && process.stdout.isTTY) {
  console.log("");
  console.log(brandHeader());
  await openMenu();
} else if (!cmd || cmd === "status") {
  await status();
} else if (cmd === "menu") {
  console.log(brandHeader());
  if (sub) {
    const item = findItem(sub);
    if (!item) { console.error(`no existe: ${sub}`); process.exit(2); }
    if (item.children) await openMenu(visible(item.children), item.label);
    else await runAction(sub);
  } else await openMenu();
} else if (findCliModule(cmd)) {
  // Cada comando vive en src/cli/commands/* y se registra en src/cli/module.ts.
  await findCliModule(cmd)!.run(sub, rest, { root: ROOT, help });
} else {
  help();
  process.exit(2);
}
