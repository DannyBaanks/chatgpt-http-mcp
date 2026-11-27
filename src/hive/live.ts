// src/hive/live.ts — Helpers de Hive Live v2: registro de sesiones con PID, liveness cross-platform,
// lectura de inbox y wake reactivo sin race conditions (compatible con HiveManager en POSIX y Windows).
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import type { HiveManager } from "./manager";
import type { HiveMessage, MessageAct, Registry, RegistryAgent } from "./types";

export type WakeMode = "wait" | "hook" | "tui";

export interface LiveSessionFields {
  pid?: number;
  harness?: string;
  host?: string;
  office_id?: string;
  session_id?: string;
  wake?: WakeMode;
}

export type LiveRegistryAgent = RegistryAgent & LiveSessionFields;

export interface LiveRosterEntry {
  agent_id: string;
  name: string;
  harness: string | null;
  role: string | null;
  pid: number | null;
  alive: boolean;
  status: string;
  host: string;
  office_id: string | null;
  cwd: string;
  session_id: string | null;
  wake: WakeMode;
  capabilities: string[];
  last_seen: number;
}

export interface RegisterLiveInput {
  agent_id: string;
  name?: string;
  harness?: string;
  role?: string;
  pid?: number;
  host?: string;
  office_id?: string;
  cwd?: string;
  session_id?: string;
  wake?: WakeMode;
  capabilities?: string[];
  is_god?: boolean;
}

const wakeBus = new EventEmitter();
wakeBus.setMaxListeners(200);

function wakeKey(hive: HiveManager, agentId: string): string {
  return `${hive.root() ?? "default"}::${agentId}`;
}

/**
 * Comprueba si un PID sigue vivo en POSIX y Windows.
 * EPERM significa que el proceso existe pero pertenece a otro usuario/sesión -> alive=true.
 * ESRCH (o pid <= 0 / no entero) -> alive=false.
 */
export function isPidAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === "EPERM") return true;
    return false;
  }
}

function writeRegistryAtomic(hive: HiveManager, reg: Registry): void {
  const root = hive.root();
  if (!root) return;
  const regPath = join(root, "registry.json");
  const tmp = `${regPath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(reg, null, 2)}\n`, "utf8");
  renameSync(tmp, regPath);
}

/**
 * Registra (o refresca heartbeat de) una sesión viva de agente en el Hive local con su PID real.
 */
export function registerLiveAgent(hive: HiveManager, input: RegisterLiveInput): LiveRosterEntry {
  const agentId = input.agent_id.trim();
  if (!agentId) throw new Error("agent_id es obligatorio");
  const cwd = input.cwd?.trim() || process.cwd();
  const name = input.name?.trim() || agentId;

  hive.ensureHive();
  hive.ensureAgent({
    id: agentId,
    name,
    provider: input.harness?.trim() || "agent",
    role: input.role?.trim() || undefined,
    capabilities: input.capabilities ?? [],
    cwd,
    isGod: input.is_god === true,
  });

  const reg = hive.registry();
  const prev = (reg.agents[agentId] ?? {}) as LiveRegistryAgent;
  const now = Date.now();
  const pid = typeof input.pid === "number" && Number.isInteger(input.pid) && input.pid > 0 ? input.pid : prev.pid;
  const host = input.host?.trim() || prev.host || os.hostname();
  const wake: WakeMode = input.wake ?? prev.wake ?? "wait";

  const updated: LiveRegistryAgent = {
    ...prev,
    id: agentId,
    name,
    provider: input.harness?.trim() || prev.provider || "agent",
    role: input.role?.trim() || prev.role,
    capabilities: input.capabilities ?? prev.capabilities ?? [],
    cwd,
    status: "idle",
    lastSeen: now,
    archived: false,
    pid,
    harness: input.harness?.trim() || prev.harness || prev.provider || "agent",
    host,
    office_id: input.office_id?.trim() || prev.office_id,
    session_id: input.session_id?.trim() || prev.session_id || prev.sessionId,
    sessionId: input.session_id?.trim() || prev.sessionId,
    wake,
  };

  reg.agents[agentId] = updated;
  writeRegistryAtomic(hive, reg);

  return toRosterEntry(updated, input.office_id ?? null);
}

function toRosterEntry(a: LiveRegistryAgent, fallbackOfficeId: string | null): LiveRosterEntry {
  const pid = typeof a.pid === "number" && Number.isInteger(a.pid) && a.pid > 0 ? a.pid : null;
  return {
    agent_id: a.id,
    name: a.name,
    harness: a.harness ?? a.provider ?? null,
    role: a.role ?? null,
    pid,
    alive: pid !== null ? isPidAlive(pid) : false,
    status: a.status,
    host: a.host ?? os.hostname(),
    office_id: a.office_id ?? fallbackOfficeId,
    cwd: a.cwd,
    session_id: a.session_id ?? a.sessionId ?? null,
    wake: a.wake ?? "wait",
    capabilities: Array.isArray(a.capabilities) ? a.capabilities : [],
    last_seen: a.lastSeen,
  };
}

export function listLiveRoster(
  hive: HiveManager,
  opts: { officeId?: string | null; includeArchived?: boolean } = {},
): LiveRosterEntry[] {
  const reg = hive.registry();
  const out: LiveRosterEntry[] = [];
  for (const agent of Object.values(reg.agents)) {
    if (!opts.includeArchived && agent.archived) continue;
    out.push(toRosterEntry(agent as LiveRegistryAgent, opts.officeId ?? null));
  }
  out.sort((a, b) => Number(b.alive) - Number(a.alive) || b.last_seen - a.last_seen);
  return out;
}

/**
 * Lee los mensajes pendientes en `agents/<agentId>/inbox/`.
 * Si `markRead=true`, mueve los archivos leídos a `inbox/.done/`.
 */
export function readAgentInbox(hive: HiveManager, agentId: string, markRead = true): HiveMessage[] {
  const dir = hive.agentDir(agentId);
  const inbox = join(dir, "inbox");
  if (!existsSync(inbox)) return [];

  const doneDir = join(inbox, ".done");
  const files = readdirSync(inbox).filter((f) => f.endsWith(".json")).sort();
  const messages: HiveMessage[] = [];

  for (const f of files) {
    const full = join(inbox, f);
    try {
      const parsed = JSON.parse(readFileSync(full, "utf8")) as HiveMessage;
      messages.push(parsed);
      if (markRead) {
        mkdirSync(doneDir, { recursive: true });
        renameSync(full, join(doneDir, f));
      }
    } catch {
      // Ignora archivos corruptos/en escritura parcial.
    }
  }

  messages.sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
  return messages;
}

/**
 * Entrega un mensaje en el Hive local y despierta inmediatamente cualquier `waitForAgentMessage` en curso.
 */
export function deliverLiveMessage(
  hive: HiveManager,
  partial: {
    to: string;
    subject: string;
    body?: string;
    act?: MessageAct;
    in_reply_to?: string | null;
    conversation?: string;
    requires_reply?: boolean;
  },
  from: string,
): HiveMessage {
  const msg = hive.send(
    {
      to: partial.to,
      subject: partial.subject,
      body: partial.body ?? "",
      act: partial.act ?? "request",
      in_reply_to: partial.in_reply_to ?? null,
      conversation: partial.conversation,
      requires_reply: partial.requires_reply,
    },
    from,
  );

  if (msg.to === "broadcast") {
    const reg = hive.registry();
    for (const id of Object.keys(reg.agents)) {
      if (id !== msg.from) wakeBus.emit(wakeKey(hive, id), msg);
    }
  } else {
    const reg = hive.registry();
    const resolved = msg.to === "god" || msg.to === "human" ? (reg.godId ?? "god") : msg.to;
    wakeBus.emit(wakeKey(hive, resolved), msg);
  }
  return msg;
}

/**
 * Espera reactivamente a que llegue al menos un mensaje para `agentId`.
 * Sin race condition: revisa `inbox/` ANTES de suscribirse al bus en memoria, y combina
 * despertar instantáneo en proceso + sondeo ligero en disco (150 ms) para procesos hermanos.
 */
export async function waitForAgentMessage(
  hive: HiveManager,
  agentId: string,
  opts: { timeoutMs?: number; markRead?: boolean } = {},
): Promise<{ woken: boolean; messages: HiveMessage[]; elapsed_ms: number }> {
  const started = Date.now();
  const timeoutMs = Math.max(0, Math.min(300_000, Number(opts.timeoutMs ?? 30_000) || 0));
  const markRead = opts.markRead !== false;

  const immediate = readAgentInbox(hive, agentId, markRead);
  if (immediate.length > 0 || timeoutMs === 0) {
    return { woken: immediate.length > 0, messages: immediate, elapsed_ms: Date.now() - started };
  }

  return new Promise((resolve) => {
    const key = wakeKey(hive, agentId);
    let settled = false;

    const finish = (messages: HiveMessage[]) => {
      if (settled) return;
      settled = true;
      wakeBus.off(key, onWake);
      clearInterval(poll);
      clearTimeout(timer);
      resolve({ woken: messages.length > 0, messages, elapsed_ms: Date.now() - started });
    };

    const checkNow = () => {
      const msgs = readAgentInbox(hive, agentId, markRead);
      if (msgs.length > 0) finish(msgs);
    };

    const onWake = () => checkNow();

    wakeBus.on(key, onWake);
    // Re-check inmediatamente después de suscribir para cerrar cualquier ventana de carrera.
    checkNow();
    if (settled) return;

    const poll = setInterval(checkNow, 150);
    const timer = setTimeout(() => finish([]), timeoutMs);
  });
}
