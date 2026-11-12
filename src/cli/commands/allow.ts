// src/cli/commands/allow.ts — `isymcp allow [status|log] | allow shell|agents on|off | allow once shell|agents`
// y `isymcp taint [status|clear]` (permisos del operador y contaminación por contenido externo).
import type { CliModule } from "../module";
import { flag } from "../args";

export const allowModule: CliModule = {
  names: ["allow"],
  async run(sub, rest) {
    // Permisos del operador (src/permissions.ts). Se leen en cada llamada: no hace falta reiniciar nada.
    const P = await import("../../permissions");
    const T = await import("../../taint");
    const alias: Record<string, "host_shell" | "agent_spawn"> = { shell: "host_shell", host_shell: "host_shell", agents: "agent_spawn", agent_spawn: "agent_spawn", consoles: "agent_spawn" };
    const left = (iso: string) => {
      const total = Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 60_000));
      const h = Math.floor(total / 60), m = total % 60;
      return h > 0 ? `${h} h ${m} min` : `${m} min`;
    };
    const show = () => {
      for (const cap of P.CAPABILITIES) {
        const src = P.permissionSource(cap);
        const fg = P.fileGrant(cap);
        const label = cap === "host_shell" ? "shell  " : "agents ";
        const what = cap === "host_shell" ? "shell_exec en el host (sin sandbox)" : "abrir consolas de agentes y pegarles tareas";
        const by = src === "env" ? `por ${P.capabilityEnvVar(cap)}` : src === "file" ? (fg.until ? `caduca en ${left(fg.until)} (${new Date(fg.until).toLocaleTimeString()})` : "sin caducidad (--forever)") : src ? "por OperatorGrant" : fg.expired ? "caducó" : "";
        const once = P.pendingOnceGrants(cap).reduce((n, g) => n + g.uses, 0);
        console.log(`  ${src ? "● ENCENDIDO" : "○ apagado  "} ${label} ${what}${by ? ` · ${by}` : ""}${once ? ` · ${once} uso(s) de un solo uso pendiente(s)` : ""}`);
      }
      showTaint(T, P.CAPABILITIES.some((c) => { const s = P.permissionSource(c); return s === "env" || s === "file"; }));
    };
    if (!sub || sub === "status") {
      show();
    } else if (sub === "log") {
      const n = Number(flag("--last", rest) ?? "20");
      const rows = P.readAudit(Number.isFinite(n) ? n : 20);
      if (rest.includes("--json")) console.log(JSON.stringify(rows, null, 2));
      else if (rows.length === 0) console.log(`  (bitácora vacía: ${P.auditLogPath()})`);
      else for (const r of rows) {
        const extra = ["agent", "console_id", "task_id", "command"].filter((k) => r[k] !== undefined).map((k) => `${k}=${String(r[k])}`).join(" ");
        const mark = r.decision === "allow" ? "✓" : r.decision === "deny" ? "✗" : "•";
        const cap = r.cap === "host_shell" ? "shell " : r.cap === "agent_spawn" ? "agents" : "      ";
        console.log(`  ${String(r.ts).slice(0, 19).replace("T", " ")}  ${mark} ${cap} ${String(r.action).padEnd(24)} ${r.source ?? (r.reason ?? "-")}${r.ttl ? ` ${r.ttl}` : ""}  ${extra}`.slice(0, 220));
      }
    } else {
      const cap = alias[sub];
      const state = rest[0];
      const usage = (msg: string): never => {
        console.error(`✗ ${msg}`);
        process.exit(2);
      };
      if (sub === "once") {
        // isymcp allow once shell|agents [--for 10m] [--uses N]
        const onceCap = alias[state ?? ""];
        if (!onceCap) usage("uso: isymcp allow once shell|agents [--for 10m (máx 1h)] [--uses N (máx 10)]");
        const forRaw = flag("--for", rest);
        const ms = forRaw !== undefined ? P.parseDuration(forRaw) : P.ONCE_DEFAULT_TTL_MS;
        if (ms === null) usage(`--for no se entiende: '${forRaw}' (usa 5m, 30m, 1h)`);
        if (ms! > P.ONCE_MAX_TTL_MS) usage("--for máximo 1h para un permiso de un solo uso");
        const usesRaw = flag("--uses", rest);
        const uses = usesRaw === undefined ? 1 : Number(usesRaw);
        if (!Number.isInteger(uses) || uses < 1 || uses > P.ONCE_MAX_USES) usage(`--uses debe ser un entero de 1 a ${P.ONCE_MAX_USES}`);
        const g = P.grantOnce(onceCap!, process.env, { ttlMs: ms!, uses });
        P.appendAudit({ cap: onceCap, action: "allow once", decision: "operator", source: "cli", uses, ttl: `${Math.round(ms! / 60_000)}m` });
        console.log(`  ✓ ${uses} uso(s) de ${onceCap === "host_shell" ? "shell" : "agents"}; si no se usa, caduca a las ${new Date(g.until).toLocaleTimeString()}`);
        return;
      }
      if (!cap || (state !== "on" && state !== "off")) {
        usage("uso: isymcp allow [status|log] | isymcp allow shell|agents on [--for 2h|--forever] | isymcp allow shell|agents off | isymcp allow once shell|agents [--for 10m] [--uses N]");
      }
      let ttl: number | null | undefined;
      if (state === "on") {
        const forRaw = flag("--for", rest);
        if (rest.includes("--forever")) ttl = null;
        else if (forRaw !== undefined) {
          const ms = P.parseDuration(forRaw);
          if (ms === null) usage(`--for no se entiende: '${forRaw}' (usa 30m, 2h, 1d)`);
          if (ms! > P.MAX_TTL_MS) usage("--for máximo 24h; para dejarlo sin caducidad usa --forever a propósito");
          ttl = ms;
        }
      }
      P.setPermission(cap, state === "on", process.env, ttl);
      P.appendAudit({ cap, action: `allow ${state}`, decision: "operator", source: "cli", ...(ttl !== undefined ? { ttl: ttl === null ? "forever" : `${Math.round(ttl / 60_000)}m` } : {}) });
      show();
      if (state === "off" && process.env[P.capabilityEnvVar(cap)] === "1") {
        console.log(`  ojo: ${P.capabilityEnvVar(cap)}=1 en el entorno lo sigue encendiendo`);
      }
    }
  },
};

type TaintModule = typeof import("../../taint");

/** Línea de estado de la contaminación; `broad` = hay un permiso general que ahora no basta. */
function showTaint(T: TaintModule, broad: boolean): void {
  const t = T.activeTaint();
  if (!t) {
    console.log("  ○ limpio     el modelo no ha leído contenido externo por ISyMCP (en las últimas 2 h)");
    return;
  }
  const until = new Date(t.until).toLocaleTimeString();
  const gate = T.taintGateEnabled() ? "" : " · ISYMCP_TAINT_GATE=0: no cierra la puerta";
  console.log(`  ⚠ contaminado ${T.describeTaint(t)} · hasta las ${until}${gate}`);
  if (broad && T.taintGateEnabled()) console.log("               el permiso general no basta: cada uso pide `isymcp allow once shell|agents`");
}

export const taintModule: CliModule = {
  names: ["taint"],
  async run(sub, rest) {
    const T = await import("../../taint");
    const P = await import("../../permissions");
    if (!sub || sub === "status") {
      const t = T.activeTaint();
      if (rest.includes("--json")) { console.log(JSON.stringify(t, null, 2)); return; }
      showTaint(T, false);
      if (t) for (const s of t.sources) console.log(`      ${s.at.slice(0, 19).replace("T", " ")}  ${s.tool}${s.detail ? `  ${s.detail}` : ""}`);
    } else if (sub === "clear") {
      const had = T.clearTaint();
      P.appendAudit({ action: "taint clear", decision: "operator", source: "cli" });
      console.log(had ? "  ✓ contaminación limpiada; la próxima lectura externa la vuelve a marcar" : "  (no había contaminación)");
    } else {
      console.error("✗ uso: isymcp taint [status [--json]|clear]");
      process.exit(2);
    }
  },
};
