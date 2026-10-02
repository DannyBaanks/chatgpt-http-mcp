#!/usr/bin/env bun
// isymcp — consola del bridge. Se puede cerrar: el server queda detached.
//
//   isymcp                 estado
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
import { runHook } from "./hooks";
import { installWebModels } from "../scripts/install-web-models";
import { defaultExportPath, exportLines, formatLine, parseBound, readAll, selectLines } from "./logs";
import { MENU, brandHeader, select, visible, visibleLabels } from "./menu";
import { buildChatGPTCommand, CONNECTOR_NAME, MENTION } from "./mcp/identity";

const ROOT = join(import.meta.dir, "..");
const RUN = join(homedir(), ".codex-web-http", "run");
const PID = join(RUN, "server.pid");
const LOG = join(RUN, "server.log");
const PORT = process.env.CODEX_WEB_HTTP_PORT?.trim() || "8791";

function sh(cmd: string[], timeout = 20_000): { code: number; out: string } {
  const proc = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe", timeout });
  return { code: proc.exitCode ?? 1, out: proc.stdout.toString() + proc.stderr.toString() };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(): number | null {
  if (!existsSync(PID)) return null;
  const n = Number(readFileSync(PID, "utf8").trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

async function serverUp(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(2_000) });
    return res.ok;
  } catch {
    return false;
  }
}

function startServer(): void {
  mkdirSync(RUN, { recursive: true });
  const existing = readPid();
  if (existing && alive(existing)) {
    console.log(`server ya corre (pid ${existing})`);
    return;
  }
  const logFd = openSync(LOG, "a");
  const child = spawn("bun", ["run", join(ROOT, "src", "cli.ts")], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      CODEX_WEB_HTTP_WEB_MODELS: process.env.CODEX_WEB_HTTP_WEB_MODELS ?? "on",
      CODEX_WEB_HTTP_PORT: PORT,
      CODEX_WEB_HTTP_CAPS: process.env.CODEX_WEB_HTTP_CAPS ?? "sol,pro,extrahigh,bigger",
    },
  });
  child.unref();
  writeFileSync(PID, `${child.pid}\n`);
  console.log(`server detached pid=${child.pid} log=${LOG}`);
  console.log("podes cerrar esta terminal: el server no es hijo de ella");
}

function stopServer(): void {
  const pid = readPid();
  if (pid && alive(pid)) {
    process.kill(pid, "SIGTERM");
    console.log(`server parado (pid ${pid})`);
  } else {
    console.log("server no estaba corriendo");
  }
  try {
    writeFileSync(PID, "");
  } catch {
    /* pid file opcional */
  }
}

function tunnelBin(): string {
  return join(homedir(), ".codex-web-http", "bin", "tunnel-client");
}

function tunnel(action: string): void {
  const bin = tunnelBin();
  if (!existsSync(bin)) {
    console.error(`no esta instalado el tunnel-client. Corre: bun run scripts/install-tunnel.ts`);
    process.exit(1);
  }
  if (action === "connect") {
    const proc = Bun.spawnSync(["bun", "run", join(ROOT, "scripts", "connect-tunnel.ts")], {
      cwd: ROOT,
      stdout: "inherit",
      stderr: "inherit",
    });
    if (proc.exitCode !== 0) console.error(`tunel connect exit ${proc.exitCode}`);
    return;
  }
  if (action === "stop") {
    const proc = sh([bin, "runtimes", "stop", "codex-web-http"]);
    console.log(proc.out.trim() || `exit ${proc.code}`);
    return;
  }
  const proc = sh([bin, "runtimes", "status", "codex-web-http", "--json"], 30_000);
  if (proc.code !== 0) {
    console.log(proc.out.trim() || "tunel sin status");
    return;
  }
  try {
    const d = JSON.parse(proc.out) as { ready?: boolean; running?: boolean; runtime_state?: string };
    console.log(`tunel ready=${d.ready ?? "?"} running=${d.running ?? "?"} state=${d.runtime_state ?? "?"}`);
  } catch {
    console.log(proc.out.slice(0, 400));
  }
}

function modelsRestore(): void {
  const result = installWebModels({ restore: true });
  console.log(JSON.stringify(result, null, 2));
}

function installIntoCodex(apply: boolean): void {
  const result = installWebModels({
    apply,
    restore: false,
    caps: "sol,pro,extrahigh,bigger",
    model: apply ? "chatgpt-web/gpt-5.6-sol" : undefined,
    effort: apply ? "high" : undefined,
  });
  console.log(JSON.stringify(result, null, 2));
  if (!apply) {
    console.log("(dry-run: no escribio. Levantar todo, o Modelos → Aplicar, si lo instala)");
    return;
  }
  console.log("instalado en Codex: ruta 8791, models_cache borrado para que Codex lo vuelva a pedir");
  console.log("cierra la app de Codex por completo y volvela a abrir");
}

function command(text: string, effort?: string): void {
  console.log(`# app: ${CONNECTOR_NAME}`);
  console.log(`# token: ${MENTION}\n`);
  console.log("--- INICIO DEL TEXTO A PEGAR ---");
  console.log(buildChatGPTCommand(text, { effort }));
  console.log("--- FIN ---");
}

async function status(): Promise<void> {
  const pid = readPid();
  const up = await serverUp();
  console.log(`isymcp`);
  console.log(`  server   ${up ? "up" : "down"}  http://127.0.0.1:${PORT}  pid=${pid && alive(pid) ? pid : "-"}`);
  console.log(`  log      ${LOG}`);
  tunnel("status");
  const mcp = sh(["pgrep", "-af", "codex-web-http/src/mcp/main.ts"]);
  const line = mcp.out.split("\n").find((l) => l.includes("mcp/main.ts") && !l.includes("pgrep"));
  console.log(`  mcp      ${line ? "up" : "down"}`);
}

function help(): void {
  console.log(`isymcp — consola del bridge Codex ISyMCP

  isymcp                     estado
  isymcp up                  levanta server (detached) y conecta el tunel
  isymcp down                para server y tunel
  isymcp server start|stop
  isymcp tunnel connect|stop|status
  isymcp models              dry-run del catalogo en Codex
  isymcp models apply        escribe la ruta (backup). Cierra Codex antes.
  isymcp models restore      vuelve al backup
  isymcp command "texto"     texto para pegar en chatgpt.com
  isymcp logs                ultimos 50
  isymcp logs --last 20
  isymcp logs export         guarda TODOS en ~/.codex-web-http/logs/
  isymcp logs export --since 2026-10-02T16:00 --until 2026-10-02T17:00
  isymcp logs export --out /tmp/isymcp.log

Cerrar esta terminal no mata el server: up lo deja detached.
`);
}

function flag(name: string, args: string[]): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function logs(args: string[]): void {
  const since = flag("--since", args);
  const until = flag("--until", args);
  const out = flag("--out", args);
  const lastRaw = flag("--last", args);
  const exporting = args[0] === "export" || args.includes("--all");
  const sinceMs = since ? parseBound(since) : undefined;
  const untilMs = until ? parseBound(until) : undefined;
  const last = exporting ? undefined : Number(lastRaw ?? "50");
  if (last !== undefined && (!Number.isInteger(last) || last < 0)) {
    throw new Error(`--last invalido: ${lastRaw}`);
  }
  const selected = selectLines(readAll(), { last, sinceMs, untilMs });
  if (!exporting) {
    if (selected.length === 0) {
      console.log("sin lineas (el server aun no escribio log, o el filtro no matchea)");
      return;
    }
    for (const line of selected) console.log(formatLine(line));
    console.log(`--- ${selected.length} lineas ---`);
    return;
  }
  const path = out ?? defaultExportPath();
  const saved = exportLines(selected, path);
  console.log(`guardado: ${saved.path}`);
  console.log(`lineas: ${saved.count}`);
}

async function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return answer.trim();
}

async function runAction(id: string): Promise<void> {
  await runHook(`before:${id}`);
  if (id === "up") {
    startServer();
    await new Promise((r) => setTimeout(r, 800));
    console.log(`health: ${(await serverUp()) ? "ok" : "aun no responde"}`);
    tunnel("connect");
    installIntoCodex(true);
  } else if (id === "down") {
    tunnel("stop");
    stopServer();
  } else if (id === "restart") {
    tunnel("stop");
    stopServer();
    startServer();
    tunnel("connect");
    installIntoCodex(true);
  } else if (id === "status") {
    await status();
  } else if (id === "server-start") startServer();
  else if (id === "server-stop") stopServer();
  else if (id === "tunnel-connect") tunnel("connect");
  else if (id === "tunnel-stop") tunnel("stop");
  else if (id === "tunnel-status") tunnel("status");
  else if (id === "logs-50") logs(["--last", "50"]);
  else if (id === "logs-20") logs(["--last", "20"]);
  else if (id === "logs-all") logs(["export", "--all"]);
  else if (id === "logs-window") {
    const since = await ask("desde (2026-10-02T16:00): ");
    const until = await ask("hasta (2026-10-02T17:00): ");
    logs(["export", "--since", since, "--until", until]);
  }   else if (id === "models-dry") installIntoCodex(false);
  else if (id === "models-apply") installIntoCodex(true);
  else if (id === "models-restore") modelsRestore();
  else if (id === "command") {
    const text = await ask("texto de la tarea: ");
    const effort = await ask("effort [high]: ") || "high";
    if (text) command(text, effort);
  }
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
    await runAction(item.id);
    console.log("");
  }
}

const [cmd, sub, ...rest] = process.argv.slice(2);
const effortFlag = rest.includes("--effort") ? rest[rest.indexOf("--effort") + 1] : undefined;

if (!cmd && process.stdin.isTTY && process.stdout.isTTY) {
  console.log("");
  console.log(brandHeader());
  await openMenu();
} else if (!cmd || cmd === "status") {
  await status();
} else if (cmd === "tree") {
  console.log(brandHeader());
  for (const label of visibleLabels()) console.log(`  ${label}`);
  const leaked = visibleLabels().filter((label) => label.startsWith("hook."));
  if (leaked.length) throw new Error(`hook visible: ${leaked.join(",")}`);
} else if (cmd === "help" || cmd === "--help" || cmd === "-h") {
  help();
} else if (cmd === "up") {
  startServer();
  await new Promise((r) => setTimeout(r, 800));
  console.log(`health: ${(await serverUp()) ? "ok" : "aun no responde"}`);
  tunnel("connect");
  installIntoCodex(true);
} else if (cmd === "down") {
  tunnel("stop");
  stopServer();
} else if (cmd === "server" && sub === "start") {
  startServer();
} else if (cmd === "server" && sub === "stop") {
  stopServer();
} else if (cmd === "tunnel" && sub) {
  tunnel(sub);
} else if (cmd === "models") {
  if (sub === "restore") modelsRestore();
  else if (sub === "apply") installIntoCodex(true);
  else installIntoCodex(false);
} else if (cmd === "command" && sub) {
  command([sub, ...rest.filter((a) => a !== "--effort" && a !== effortFlag)].join(" "), effortFlag);
} else if (cmd === "logs") {
  logs([sub, ...rest].filter((part): part is string => Boolean(part)));
} else {
  help();
  process.exit(2);
}
