// src/hive/relay-access.ts — Modos de acceso del relay del Hive, mismo esquema que `isymcp shell exec`:
//
//   none  solo texto: el agente contesta sin herramientas (por defecto).
//   ro    solo lectura: puede leer/buscar dentro de --cwd, no escribe ni ejecuta nada que modifique.
//   rw    escritura en el workspace: edita dentro de --cwd; sin acceso fuera de él.
//   full  sin límites: exige --for <duración> (máx 24 h), queda en la bitácora de permisos y el relay
//         se apaga solo al caducar (fail closed).
//
// Cada harness aplica el modo con SUS propios permisos (verificado con --help, 2026-11-27):
//   claude 2.1.x  --tools / --restricted / --permission-mode / --permission-prompts none
//   codex 0.172   exec --sandbox read-only | workspace-write | --dangerously-bypass-approvals-and-sandbox
// Un harness que no puede cumplir un modo lo rechaza en vez de dar más acceso del pedido.
import { MAX_TTL_MS, parseDuration } from "../permissions";

export type RelayAccess = "none" | "ro" | "rw" | "full";
export type RelayHarness = "claude" | "codex";

export const RELAY_ACCESS: RelayAccess[] = ["none", "ro", "rw", "full"];
export const RELAY_HARNESSES: RelayHarness[] = ["claude", "codex"];

export interface RelayCommand {
  argv: string[];
  access: RelayAccess;
  harness: RelayHarness;
  /** ms epoch en que caduca el acceso full (null para los demás modos). */
  expiresAt: number | null;
}

const READ_TOOLS = "Read,Glob,Grep";
const WRITE_TOOLS = "Read,Glob,Grep,Edit,Write";

/** argv headless del harness para un modo de acceso. El mensaje SIEMPRE entra por stdin. */
export function relayCommand(
  harness: string,
  access: string,
  opts: { cwd: string; forRaw?: string; now?: number },
): RelayCommand {
  const h = harness.trim().toLowerCase() as RelayHarness;
  const a = access.trim().toLowerCase() as RelayAccess;
  if (!RELAY_HARNESSES.includes(h)) throw new Error(`harness no soportado: ${harness} (usa ${RELAY_HARNESSES.join("|")}, o -- <cli> para uno propio)`);
  if (!RELAY_ACCESS.includes(a)) throw new Error(`acceso inválido: ${access} (usa ${RELAY_ACCESS.join("|")})`);

  let expiresAt: number | null = null;
  if (a === "full") {
    const ttl = parseDuration(opts.forRaw);
    if (!ttl) throw new Error("--access full exige --for <duración> (ej. 30m, 2h; máx 24h)");
    if (ttl > MAX_TTL_MS) throw new Error("--for no puede pasar de 24h");
    expiresAt = (opts.now ?? Date.now()) + ttl;
  } else if (opts.forRaw !== undefined) {
    throw new Error("--for solo aplica a --access full");
  }

  let argv: string[];
  if (h === "claude") {
    // --permission-prompts none: en headless nadie contesta; lo que pediría permiso se deniega.
    const base = ["claude", "-p", "--permission-prompts", "none"];
    if (a === "none") argv = [...base, "--tools", "", "--strict-mcp-config"];
    else if (a === "ro") argv = [...base, "--restricted", "--tools", READ_TOOLS, "--strict-mcp-config"];
    else if (a === "rw")
      argv = [...base, "--restricted", "--tools", WRITE_TOOLS, "--permission-mode", "acceptEdits", "--strict-mcp-config"];
    else argv = ["claude", "-p", "--dangerously-skip-permissions"];
  } else {
    // codex exec sin PROMPT lee las instrucciones de stdin.
    const base = ["codex", "exec", "--skip-git-repo-check", "-C", opts.cwd];
    if (a === "none") throw new Error("codex no puede desactivar sus herramientas: usa --access ro (sandbox read-only)");
    if (a === "ro") argv = [...base, "--sandbox", "read-only"];
    else if (a === "rw") argv = [...base, "--sandbox", "workspace-write"];
    else argv = [...base, "--dangerously-bypass-approvals-and-sandbox"];
  }
  return { argv, access: a, harness: h, expiresAt };
}

/**
 * Con `shell: true` (Windows, CLIs .cmd/.ps1) Node concatena argv sin comillas: un argumento vacío
 * (`--tools ""`) desaparecería y uno con espacios se partiría. Se citan para cmd.exe.
 */
export function quoteForWindowsShell(arg: string): string {
  if (arg !== "" && !/[\s"&|<>^%(),;]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}
