#!/usr/bin/env bun
// connect-tunnel.ts — conexion reproducible del tunel con nuestro MCP.
//
// Lee el tunnel id guardado por install-tunnel.ts, la runtime key (0600) y el
// organization id, y ejecuta 'runtimes connect' con nuestro servidor MCP stdio
// como --mcp-command. Idempotente: si ya corre, el JSON dice already_running.
//
//   bun run scripts/connect-tunnel.ts
//   bun run scripts/connect-tunnel.ts --org-file ~/Development/organ.txt
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { assertExclusiveTunnel, configuredTunnelAlias } from "../src/tunnel-routing";
import { securePrivatePath } from "../src/platform/private-path";

function home(): string {
  return process.env.CODEX_WEB_HTTP_HOME?.trim() || join(homedir(), ".codex-web-http");
}
function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

// tunnel-client parses this string into argv itself, then execs argv[0]
// directly (no shell). Escape its backslash-based quoting syntax so Windows
// executable paths and the named-pipe endpoint survive parsing unchanged.
function tunnelCommandArg(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

const alias = configuredTunnelAlias(home(), argValue("--alias") ?? process.env.CODEX_WEB_HTTP_TUNNEL_ALIAS);
const tunnelJsonPath = join(home(), "tunnel.json");
if (!existsSync(tunnelJsonPath)) {
  console.error(`no existe ${tunnelJsonPath}; corre primero install-tunnel.ts`);
  process.exit(2);
}
const saved = JSON.parse(readFileSync(tunnelJsonPath, "utf8")) as { tunnelId?: string };
const tunnelId = argValue("--tunnel-id") ?? saved.tunnelId;
if (!tunnelId || !/^tunnel_[a-f0-9]{32}$/.test(tunnelId)) {
  console.error(`tunnel id invalido: ${tunnelId ?? "(vacio)"}`);
  process.exit(2);
}

const keyFile = argValue("--key-file") ?? join(home(), "secrets", "tunnel-runtime.key");
if (!existsSync(keyFile)) {
  console.error(`no existe la runtime key: ${keyFile}`);
  process.exit(2);
}

// Attaching an existing ID uses its runtime credential, not admin CRUD or an
// organization scope. Preserve any stored organization metadata as-is.

const binary = join(home(), "bin", process.platform === "win32" ? "tunnel-client.exe" : "tunnel-client");
if (!existsSync(binary)) {
  console.error(`no existe ${binary}; corre install-tunnel.ts`);
  process.exit(2);
}

// Check identity before generating a launcher or touching any managed runtime.
const inventory = Bun.spawnSync([binary, "runtimes", "list", "--json"], { timeout: 15_000 });
if (inventory.exitCode !== 0) throw new Error("tunnel_inventory_unavailable: refusing to connect");
assertExclusiveTunnel(JSON.parse(inventory.stdout.toString()), alias, tunnelId);

// tunnel-client recibe el comando como UN string y en Windows ejecuta argv[0]
// directamente; por eso no se puede apuntar a un .cmd. Windows pasa bun.exe y
// la ruta TypeScript como argv; Unix usa un pequeño lanzador con shebang.
function mcpLauncher(): string {
  const mainTs = join(import.meta.dir, "..", "src", "mcp", "main.ts");
  const binDir = join(home(), "bin");
  mkdirSync(binDir, { recursive: true });
  securePrivatePath(binDir, true);
  const launcher = join(binDir, "isymcp-mcp");
  const quoted = `'${mainTs.replace(/'/g, `'\\''`)}'`;
  writeFileSync(launcher, `#!/usr/bin/env bash\n# generado por scripts/connect-tunnel.ts\nexec bun run ${quoted} "$@"\n`, { mode: 0o700 });
  securePrivatePath(launcher, false, 0o700);
  return launcher;
}

const windowsMcpArgs = [
  process.execPath,
  "run",
  join(import.meta.dir, "..", "src", "mcp", "main.ts"),
  "--contract", "native",
  "--broker-socket", "\\\\.\\pipe\\codex-web-http-broker",
];
const mcpCommand = argValue("--mcp-command") ?? (process.platform === "win32"
  ? windowsMcpArgs.map(tunnelCommandArg).join(" ")
  : `${tunnelCommandArg(mcpLauncher())} --contract native --broker-socket /tmp/codex-web-http-broker.sock`);

const proc = Bun.spawnSync([
  binary, "runtimes", "connect",
  "--alias", alias,
  "--profile", alias,
  "--profile-dir", join(home(), "tunnel", "profiles"),
  "--tunnel-client-bin", binary,
  "--tunnel-id", tunnelId,
  "--runtime-api-key", `file:${keyFile}`,
  "--mcp-command", mcpCommand,
  "--json",
], { timeout: 120_000 });

const stdout = proc.stdout.toString();
const stderr = proc.stderr.toString();
if (proc.exitCode !== 0) {
  console.error(`connect fallo (exit ${proc.exitCode}): ${(stderr || stdout).slice(0, 500)}`);
  process.exit(1);
}

let parsed: Record<string, unknown>;
try {
  parsed = JSON.parse(stdout) as Record<string, unknown>;
} catch {
  console.error(`salida no-JSON: ${stdout.slice(0, 300)}`);
  process.exit(1);
}

writeFileSync(tunnelJsonPath, JSON.stringify({ ...saved, alias, tunnelId, connectedAt: new Date().toISOString() }, null, 2) + "\n", { mode: 0o600 });

const health = (parsed.local as Record<string, unknown> | undefined)?.effective_health as
  | { healthz?: { ok?: boolean; body?: string }; readyz?: { ok?: boolean; body?: string }; ui?: string }
  | undefined;
console.log("tunel connect (sin imprimir secretos):");
console.log(`  alias:        ${alias}`);
console.log(`  tunnel:       ${String(tunnelId).slice(0, 15)}...`);
console.log(`  running:      ${parsed.running ?? parsed.process_running}`);
console.log(`  ready:        ${parsed.ready}`);
console.log(`  runtime:      ${parsed.runtime_state}`);
console.log(`  healthz:      ${health?.healthz?.ok ? `OK (${health.healthz.body})` : "?"}`);
console.log(`  readyz:       ${health?.readyz?.ok ? `OK (${health.readyz.body})` : "?"}`);
console.log(`  ui:           ${parsed.ui_url ?? health?.ui ?? "(no reportada)"}`);
console.log(`  mcp_command:  ${mcpCommand}`);
