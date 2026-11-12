// src/cli/commands/allow.ts — `isymcp allow [status|log] | allow shell|agents on|off` (permisos del operador).
import type { CliModule } from "../module";
import { flag } from "../args";

export const allowModule: CliModule = {
  names: ["allow"],
  async run(sub, rest) {
    // Permisos del operador (src/permissions.ts). Se leen en cada llamada: no hace falta reiniciar nada.
    const P = await import("../../permissions");
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
        console.log(`  ${src ? "● ENCENDIDO" : "○ apagado  "} ${label} ${what}${by ? ` · ${by}` : ""}`);
      }
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
        const cap = r.cap === "host_shell" ? "shell " : "agents";
        console.log(`  ${String(r.ts).slice(0, 19).replace("T", " ")}  ${mark} ${cap} ${String(r.action).padEnd(24)} ${r.source ?? (r.reason ?? "-")}${r.ttl ? ` ${r.ttl}` : ""}  ${extra}`.slice(0, 220));
      }
    } else {
      const cap = alias[sub];
      const state = rest[0];
      const usage = (msg: string): never => {
        console.error(`✗ ${msg}`);
        process.exit(2);
      };
      if (!cap || (state !== "on" && state !== "off")) {
        usage("uso: isymcp allow [status|log] | isymcp allow shell|agents on [--for 2h|--forever] | isymcp allow shell|agents off");
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
