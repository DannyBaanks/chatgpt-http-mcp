// src/cli/commands/hub.ts — `isymcp hub serve|connect|status|import|reload|stop|install|build|restart`
//
// El hub de MCP: un daemon ajeno a las TUIs que arranca una vez los MCP de la máquina; cada TUI
// registra un solo MCP (el conector) y ve 3 tools (discover/describe/execute).
// El daemon y el conector son un binario Zig (hub/, memoria acotada y predecible); esta CLI es
// el frontend: escribe servers.json, instala la unidad systemd y consulta el estado.
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CliModule } from "../module";
import { flag } from "../args";

const HELP = `isymcp hub — un daemon de MCP para todas las TUIs

  isymcp hub serve [--quiet]      arranca el daemon (normalmente lo hace systemd o el conector)
  isymcp hub connect              conector stdio: es lo que se registra como MCP en cada TUI
  isymcp hub connect --direct N   lanza tal cual el MCP N (mode "direct" en servers.json) con el
                                  entorno de la TUI: para MCP con tokens o datos de sesión
  isymcp hub status [--json]      MCP detrás del hub, procesos y errores
  isymcp hub import [--from F] [--per-client a,b]
                                  copia los MCP stdio de una config con mcpServers (por defecto
                                  ~/.claude.json) a servers.json; per-client por defecto: rea
  isymcp hub restart N [--instance ID]
                                  reinicia solo el MCP N (SIGTERM a sus procesos; el hub los
                                  relanza en ~1 s). Los demás MCP y las TUIs no se cortan
  isymcp hub reload               relee servers.json (SIGHUP; hoy reinicia TODOS los MCP, #315a)
  isymcp hub stop                 para el daemon y sus MCP
  isymcp hub build                compila el binario Zig (hub/zig-out/bin/isymcp-hub)
  isymcp hub install [--enable]   compila, enlaza ~/.codex-web-http/bin/isymcp-hub y escribe la
                                  unidad systemd de usuario isymcp-hub.service (--enable la activa)

servers.json: ${"<bridge home>"}/hub/servers.json (ISYMCP_HUB_CONFIG lo cambia)
socket:       $XDG_RUNTIME_DIR/isymcp/hub.sock (ISYMCP_HUB_SOCKET lo cambia)`;

async function hubBinary(root: string, build = false): Promise<string> {
  const { hubBinaryPath } = await import("../../hub/paths");
  const bin = hubBinaryPath(root);
  if (build || !existsSync(bin)) {
    const { spawnSync } = await import("node:child_process");
    const r = spawnSync("zig", ["build", "-Doptimize=ReleaseSafe"], { cwd: join(root, "hub"), stdio: "inherit" });
    if (r.status !== 0) throw Error("zig build falló (hace falta Zig 0.16 en el PATH)");
  }
  return bin;
}

/** Reemplaza este proceso por el binario (mismo stdin/stdout/señales). */
async function execBinary(bin: string, args: string[]): Promise<never> {
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync(bin, args, { stdio: "inherit" });
  process.exit(r.status ?? 1);
}

/** pid del daemon, solo si /proc confirma que ese proceso es de verdad `isymcp hub serve`. */
async function daemonPid(): Promise<number | null> {
  const { hubSocketPath } = await import("../../hub/paths");
  const pidFile = join(hubSocketPath(), "..", "hub.pid");
  if (!existsSync(pidFile)) return null;
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 1) return null;
  try {
    // El daemon es el binario Zig: argv = [<ruta>/isymcp-hub, "serve", ...].
    const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
    return /(^|\/)isymcp-hub$/.test(cmd[0] ?? "") && cmd[1] === "serve" ? pid : null;
  } catch {
    return null;
  }
}

/** Estado del daemon vía `hub_discover detail=status` (null si no corre). No lo autoarranca. */
async function hubStatusData(root: string): Promise<{ servers: Array<Record<string, any>> } | null> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const transport = new StdioClientTransport({
    command: await hubBinary(root),
    args: ["connect"],
    env: { ...(process.env as Record<string, string>), ISYMCP_HUB_NO_AUTOSTART: "1", ISYMCP_HUB_CONNECT_WAIT_MS: "0" },
    stderr: "pipe",
  });
  const client = new Client({ name: "isymcp-hub-status", version: "0" });
  try {
    await client.connect(transport, { timeout: 5_000 });
  } catch {
    return null;
  }
  try {
    const res = await client.callTool({ name: "hub_discover", arguments: { detail: "status" } });
    return res.structuredContent as { servers: Array<Record<string, any>> };
  } finally {
    await client.close();
  }
}

/** ppid según /proc (null si el proceso ya no existe). */
function parentPid(pid: number): number | null {
  try {
    // /proc/<pid>/stat: "pid (comm) state ppid ..."; comm puede llevar espacios y paréntesis.
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    return Number.isInteger(ppid) ? ppid : null;
  } catch {
    return null;
  }
}

export const hubModule: CliModule = {
  names: ["hub"],
  async run(sub, rest, ctx) {
    if (!sub || sub === "help" || sub === "--help") { console.log(HELP); return; }

    if (sub === "serve" || sub === "connect") await execBinary(await hubBinary(ctx.root), [sub, ...rest]);

    if (sub === "build") {
      console.log(`  binario: ${await hubBinary(ctx.root, true)}`);
      return;
    }

    if (sub === "status") {
      const data = await hubStatusData(ctx.root);
      if (!data) {
        console.log("  ○ el hub no está corriendo (isymcp hub serve, o systemctl --user start isymcp-hub)");
        process.exitCode = 1;
        return;
      }
      if (rest.includes("--json")) { console.log(JSON.stringify(data, null, 2)); return; }
      const pid = await daemonPid();
      console.log(`  ● hub corriendo${pid ? ` (pid ${pid})` : ""}`);
      for (const s of data.servers) {
        const mark = s.state === "ready" ? "●" : s.state === "starting" ? "◐" : s.state === "disabled" || s.state === "idle" ? "○" : s.state === "direct" ? "→" : "✗";
        const ver = s.serverInfo ? ` ${s.serverInfo.name} ${s.serverInfo.version}` : "";
        console.log(s.state === "direct"
          ? `  ${mark} ${s.server.padEnd(16)} direct      MCP propio en cada TUI: isymcp-hub connect --direct ${s.server}`
          : `  ${mark} ${s.server.padEnd(16)} ${String(s.state).padEnd(9)} ${String(s.tools).padStart(4)} tools  ${s.isolation}${ver}`);
        for (const i of s.instances ?? []) {
          console.log(`      ${i.id} pid=${i.pid ?? "-"} ${i.state}${i.client ? ` ${i.client}` : ""}${i.ready_ms !== undefined ? ` listo en ${i.ready_ms} ms` : ""}${i.in_flight ? ` · ${i.in_flight} en vuelo` : ""}`);
        }
        if (s.error && s.state !== "ready") console.log(`      error: ${String(s.error).slice(0, 300)}`);
      }
      return;
    }

    if (sub === "restart") {
      // Reinicio de UN MCP: SIGTERM a sus procesos y el daemon los vuelve a arrancar (~1 s,
      // scheduleRestart). A diferencia de `reload` (SIGHUP), no toca al resto de MCP (#315a).
      const name = rest.find((a) => !a.startsWith("--"));
      const only = flag("--instance", rest);
      if (!name) throw Error("uso: isymcp hub restart <mcp> [--instance <id>]");
      const pid = await daemonPid();
      if (!pid) { console.log("  ○ el hub no está corriendo"); process.exitCode = 1; return; }
      const data = await hubStatusData(ctx.root);
      const server = data?.servers.find((s) => s.server === name);
      if (!server) { console.log(`  ✗ ${name}: no está en el hub`); process.exitCode = 1; return; }
      if (server.state === "direct") {
        console.log(`  ✗ ${name}: es direct (cada TUI lanza el suyo); no lo gestiona el hub`);
        process.exitCode = 1;
        return;
      }
      const instances = (server.instances ?? []) as Array<{ id: string; pid: number | null }>;
      const targets = instances.filter((i) => typeof i.pid === "number" && (!only || i.id === only));
      if (targets.length === 0) {
        console.log(`  ○ ${name}: sin procesos vivos${only ? ` con id ${only}` : ""} (arranca en la próxima llamada)`);
        return;
      }
      let killed = 0;
      for (const inst of targets) {
        // Solo hijos directos del daemon: un pid reciclado nunca recibe la señal.
        if (parentPid(inst.pid!) !== pid) {
          console.log(`  · ${inst.id} pid=${inst.pid}: no es hijo del hub (${pid}); no se toca`);
          continue;
        }
        process.kill(inst.pid!, "SIGTERM");
        killed++;
        console.log(`  ↻ ${inst.id} pid=${inst.pid}: SIGTERM`);
      }
      console.log(killed
        ? `  ${name}: ${killed} proceso(s) terminados; el hub los vuelve a arrancar en ~1 s (llamadas en vuelo de este MCP fallan)`
        : `  ${name}: nada reiniciado`);
      if (!killed) process.exitCode = 1;
      return;
    }

    if (sub === "import") {
      const C = await import("../../hub/config");
      const from = flag("--from", rest) ?? join(homedir(), ".claude.json");
      const perClient = new Set((flag("--per-client", rest) ?? "rea").split(",").map((s) => s.trim()).filter(Boolean));
      const source = JSON.parse(readFileSync(from, "utf8")) as { mcpServers?: Record<string, unknown> };
      if (!source.mcpServers) throw Error(`${from} no tiene mcpServers`);
      const config = C.loadHubConfig();
      const res = C.importMcpServers(config, source.mcpServers, perClient);
      C.saveHubConfig(config);
      for (const n of res.added) console.log(`  + ${n} (${config.servers[n].isolation})`);
      for (const s of res.skipped) console.log(`  · ${s.name}: ${s.reason}`);
      console.log(`  servers.json: ${C.hubConfigPath()}${res.added.length ? " — si el hub corre: isymcp hub reload" : ""}`);
      return;
    }

    if (sub === "reload" || sub === "stop") {
      const pid = await daemonPid();
      if (!pid) { console.log("  ○ el hub no está corriendo"); process.exitCode = 1; return; }
      process.kill(pid, sub === "reload" ? "SIGHUP" : "SIGTERM");
      console.log(sub === "reload" ? `  ↻ recargando servers.json (pid ${pid})` : `  ■ parando el hub (pid ${pid})`);
      return;
    }

    if (sub === "install") {
      const built = await hubBinary(ctx.root, true);
      const bin = join(homedir(), ".codex-web-http", "bin");
      mkdirSync(bin, { recursive: true });
      const shim = join(bin, "isymcp-hub");
      // Script de una línea (no symlink) para que `zig build` futuro no deje la TUI con un binario a medias.
      writeFileSync(shim, `#!/bin/sh\n# generado por isymcp hub install\nexec '${built}' "$@"\n`);
      chmodSync(shim, 0o755);
      const unitDir = join(homedir(), ".config", "systemd", "user");
      mkdirSync(unitDir, { recursive: true });
      const unit = join(unitDir, "isymcp-hub.service");
      writeFileSync(unit, [
        "[Unit]",
        "Description=isymcp hub: MCP compartidos para todas las TUIs",
        "After=graphical-session.target",
        "",
        "[Service]",
        `ExecStart='${built}' serve --quiet`,
        "ExecReload=/bin/kill -HUP $MAINPID",
        "Restart=on-failure",
        "RestartSec=3",
        // Al parar, systemd mata el grupo entero: no quedan MCP huérfanos.
        "KillMode=control-group",
        "",
        "[Install]",
        "WantedBy=default.target",
        "",
      ].join("\n"));
      console.log(`  conector: ${shim}`);
      console.log(`  unidad:   ${unit}`);
      if (rest.includes("--enable")) {
        const { spawnSync } = await import("node:child_process");
        // Las TUIs heredan el entorno de la sesión gráfica; el daemon lo necesita igual (PATH, DISPLAY...).
        spawnSync("systemctl", ["--user", "import-environment", "PATH", "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS"], { stdio: "inherit" });
        spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
        const r = spawnSync("systemctl", ["--user", "enable", "--now", "isymcp-hub.service"], { stdio: "inherit" });
        process.exitCode = r.status ?? 1;
      } else {
        console.log("  para activarlo: systemctl --user daemon-reload && systemctl --user enable --now isymcp-hub");
      }
      console.log(`  en cada TUI registra un solo MCP: command=${shim} args=["connect"]`);
      return;
    }

    console.log(HELP);
    process.exitCode = 1;
  },
};
