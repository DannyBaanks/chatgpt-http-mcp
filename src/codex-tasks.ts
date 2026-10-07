// codex-tasks.ts — vista de solo lectura de las tareas de Codex (API
// Responses, src/responses/task-turn.ts) para el panel.
//
// Cada tarea de Codex vive en ~/.codex-web-http/codex-responses/task-<id>.json
// con su conversacion de GPT.com y su transcript (PRIVADO). Aqui solo salen
// metadatos: id corto, conversacion, cuantos turnos, ultima actividad y estado.
// Nunca el texto.
//
// Estados:
//   lista      — la ultima respuesta quedo confirmada; acepta el siguiente turno.
//   en curso   — hay un lease: un turno se esta procesando ahora.
//   bloqueada  — un envio quedo sin confirmar (pending). Por diseño NO se
//                reenvia solo: hay que revisar la conversacion a mano.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { bridgeHome } from "./codex-sessions";
import { canonicalConversationUrl } from "./web-turn";

export interface CodexTaskView {
  id: string;
  conversation: string | null;
  turns: number;
  updated: string;
  state: "lista" | "en curso" | "bloqueada" | "ilegible";
}

export function codexTasksDir(): string {
  return join(bridgeHome(), "codex-responses");
}

export function listCodexTasks(dir = codexTasksDir(), limit = 12): CodexTaskView[] {
  if (!existsSync(dir)) return [];
  const out: CodexTaskView[] = [];
  for (const name of readdirSync(dir)) {
    const m = /^task-(.+)\.json$/.exec(name);
    if (!m) continue;
    const key = m[1]!;
    const path = join(dir, name);
    let updated = "";
    try { updated = statSync(path).mtime.toISOString(); } catch { /* carrera con un borrado */ }
    const leased = existsSync(join(dir, `lease-${key}`));
    try {
      const task = JSON.parse(readFileSync(path, "utf8")) as { url?: unknown; input?: unknown; pending?: unknown };
      const input = Array.isArray(task.input) ? (task.input as Array<{ role?: unknown }>) : [];
      out.push({
        id: key.slice(0, 12),
        conversation: typeof task.url === "string" ? canonicalConversationUrl(task.url) : null,
        turns: input.filter((i) => i && i.role === "assistant").length,
        updated,
        state: leased ? "en curso" : task.pending ? "bloqueada" : "lista",
      });
    } catch {
      out.push({ id: key.slice(0, 12), conversation: null, turns: 0, updated, state: "ilegible" });
    }
  }
  return out.sort((a, b) => b.updated.localeCompare(a.updated)).slice(0, limit);
}

/** ¿Esta programado el canario diario (timer de systemd de usuario)? */
export function canaryScheduled(): boolean | null {
  try {
    const p = Bun.spawnSync(["systemctl", "--user", "is-enabled", "isymcp-canary.timer"], { stdout: "pipe", stderr: "ignore" });
    return p.stdout.toString().trim() === "enabled";
  } catch {
    return null;
  }
}
