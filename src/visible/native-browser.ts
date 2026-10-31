// Capability gate only. Browser tools in a Codex chat do not constitute an
// externally callable BrowserDriverPort or a registered native execution owner.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function nativeBrowserStatus() {
  return {
    version: "isymcp-native-browser-gate/1",
    browser: "native",
    ready: false,
    fallback: "none",
    phase: "capability-gate",
    modes: {
      codex: {
        state: "blocked",
        blocker: "native_browser_general_owner_adapter_unverified",
        detail:
          ("Existe un adaptador experimental para un canario fijo mediado por el agente; falta demostrar el retorno MCP y el adaptador de ejecución general " +
            "para las pestañas nativas."),
      },
      autonomous: {
        state: "blocked",
        blocker: "native_browser_external_control_unverified",
        detail: "No hay un adaptador verificado que permita al panel o CLI abrir, controlar y recuperar la pestaña integrada sin este chat activo.",
      },
    },
    acceptance: {
      boundNativeRead: "unverified",
      boundNativePatch: "unverified",
      boundNativeProcess: "unverified",
      twoConcurrentPairs: "unverified",
      autonomousRecovery: "unverified",
    },
    next_action:
      "Implementar y demostrar el adaptador de propietario y navegador con un recibo MCP/nativo correlacionado antes de ampliar permisos o concurrencia.",
  };
}

/** Explicit browser selection must never be discarded by a legacy entrypoint. */
export function rejectUnavailableBrowser(browser: unknown): Response | null {
  if (browser === undefined) return null;
  if (browser !== "native") return Response.json({
    error: { type: "browser_selection_invalid", message: "La selección explícita admitida es browser=native." },
  }, { status: 400 });
  return Response.json({
    error: {
      type: "native_browser_unavailable",
      message:
        "Navegador nativo bloqueado: falta un propietario y adaptador verificados. Consulta isymcp native-browser status --json. No se envió el mensaje.",
    },
    native_browser: nativeBrowserStatus(),
  }, { status: 503, headers: { "cache-control": "no-store" } });
}

export function parseBrowserOption(args: string[]): { args: string[]; browser?: string } {
  const remaining: string[] = [];
  let browser: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg !== "--browser" && !arg.startsWith("--browser=")) {
      remaining.push(arg);
      continue;
    }
    if (browser !== undefined) throw Error("browser_selection_duplicate");
    const value = arg === "--browser" ? args[++i] : arg.slice("--browser=".length);
    if (!value || value.startsWith("--")) throw Error("browser_selection_missing");
    browser = value;
  }
  return { args: remaining, ...(browser === undefined ? {} : { browser }) };
}

/** Parse request declarations only: references, response examples and tool
 * descriptions are not evidence of a supported browser control interface. */
export function declaredClientMethods(schema: unknown): string[] {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw Error("native_browser_schema_invalid");
  const methods = new Set<string>();
  function visit(value: unknown) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const row = value as Record<string, any>;
    const method = row.properties?.method;
    if (method && typeof method === "object") {
      if (typeof method.const === "string") methods.add(method.const);
      if (Array.isArray(method.enum)) for (const name of method.enum) if (typeof name === "string") methods.add(name);
    }
    for (const entry of Object.values(row)) visit(entry);
  }
  visit(schema);
  if (!methods.has("initialize") || !methods.has("thread/start") || !methods.has("turn/start"))
    throw Error("native_browser_schema_invalid");
  return [...methods].sort();
}

/** Reads the installed protocol; never starts a thread, copies authentication,
 * opens a browser, mints a token or edits Codex configuration. Even a browser-
 * named RPC is only a candidate until the live end-to-end contract is proven. */
export async function probeNativeBrowser(binary = "codex") {
  const directory = mkdtempSync(join(tmpdir(), "isymcp-native-browser-probe-"));
  let stage = "version";
  try {
    const { stdout: versionOutput } = await execFileAsync(binary, ["--version"], { timeout: 5000, maxBuffer: 64 * 1024 });
    const version = versionOutput.trim();
    if (!/^codex(?:-cli)? \d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version) || version.length > 160)
      throw Error("unexpected_version");
    stage = "schema";
    await execFileAsync(binary, ["app-server", "generate-json-schema", "--experimental", "--out", directory], {
      timeout: 15000, maxBuffer: 128 * 1024,
    });
    const schema = readFileSync(join(directory, "ClientRequest.json"), "utf8");
    const methods = declaredClientMethods(JSON.parse(schema));
    const browserMethods = methods.filter(method => /(?:^|\/)(?:browser|tabs?)(?:\/|$)/i.test(method));
    return {
      ...nativeBrowserStatus(),
      protocol: {
        inspectedAt: new Date().toISOString(), version,
        clientRequestSha256: createHash("sha256").update(schema).digest("hex"),
        methodCount: methods.length, browserMethodCandidates: browserMethods,
        note: "La inspección del protocolo no prueba disponibilidad de herramientas inyectadas por la app, control externo del navegador ni ejecución E2E.",
      },
    };
  } catch {
    // Child stderr and file contents can contain host data. Report the stage,
    // never raw subprocess diagnostics or an optimistic empty method list.
    return { ...nativeBrowserStatus(), protocol: { error: `native_browser_probe_${stage}_failed` } };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export async function nativeBrowserCommand(sub: string | undefined, args: string[]): Promise<number> {
  if (!["status", "probe"].includes(sub ?? "status") || args.some(arg => arg !== "--json")) {
    console.error("uso: isymcp native-browser status|probe [--json]");
    return 2;
  }
  const report = sub === "probe" ? await probeNativeBrowser() : nativeBrowserStatus();
  if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else {
    console.log("NAVEGADOR NATIVO · blocked · E2E sin demostrar");
    for (const [mode, state] of Object.entries(report.modes)) console.log(`${mode}: ${state.blocker}\n  ${state.detail}`);
    if ("protocol" in report) console.log(JSON.stringify(report.protocol, null, 2));
    console.log(report.next_action);
  }
  return sub === "probe" ? 2 : 0;
}
