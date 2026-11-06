import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Un solo resolutor del binario gestionado. ISYMCP_TUNNEL_CLIENT_BIN permite
 * demostrar el ciclo con un cliente falso, igual que ISYMCP_CODEX_CLI_BIN; afecta
 * solo a resolver/ejecutar — install-tunnel.ts sigue escribiendo la ruta gestionada.
 */
export function tunnelClientPath(home: string): string {
  return process.env.ISYMCP_TUNNEL_CLIENT_BIN?.trim()
    || join(home, "bin", process.platform === "win32" ? "tunnel-client.exe" : "tunnel-client");
}

export function configuredTunnelAlias(home: string, override?: string): string {
  const path = join(home, "tunnel.json");
  const saved = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  const alias = override ?? saved.alias ?? "codex-web-http";
  if (typeof alias !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(alias)) throw new Error("tunnel_alias_invalid");
  return alias;
}

/** A shared remote ID cannot safely identify which local backend an operator
 * meant. Never connect/stop through a stale alias that belongs to another app.
 */
export function assertExclusiveTunnel(inventory: unknown, alias: string, tunnelId?: string): void {
  const rows = (inventory as { aliases?: unknown })?.aliases;
  if (!Array.isArray(rows)) throw new Error("tunnel_inventory_invalid: refusing a lifecycle change");
  const own = rows.find(row => row?.alias === alias);
  const id = tunnelId ?? own?.tunnel_id;
  if (typeof id !== "string" || !/^tunnel_[a-f0-9]{32}$/.test(id)) throw new Error("tunnel_identity_missing");
  const foreign = rows.filter(row => row?.alias !== alias && row?.tunnel_id === id);
  if (foreign.length) throw new Error(`tunnel_identity_shared: ${alias} shares its tunnel with ${foreign.map(row => String(row.alias)).join(", ")}; configure a separate tunnel`);
}
