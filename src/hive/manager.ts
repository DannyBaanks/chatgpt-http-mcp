// src/hive/manager.ts — Núcleo Hive headless extraído de isyco-worlds (cero Electron).
//
// Mantiene compatibilidad 100 % con el layout en disco de HIVE.md:
//   <hiveRoot>/
//     PROTOCOL.md, registry.json, board.md, tasks.json, log.jsonl, bin/cth-hook.cjs
//     agents/<agentId>/{identity.md, memory.md, inbox/, inbox/.done/, outbox/, outbox/.sent/, cursor.json}
//
// Reglas preservadas:
//   - Single-committer git con `gc.autoDetach=false`, retry+backoff y recuperación de stale locks.
//   - Escrituras atómicas por temp+rename para evitar archivos truncados.
//   - Redacción conservadora de secretos (`redactSecrets`).
//   - Fusión no destructiva del ledger (`mergeTaskLedger`).
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { bridgeHome } from "../codex-sessions";
import { localIpcPath } from "../platform/ipc";
import { mergeTaskLedger } from "./task-ledger";
import {
  GPT_PRINCIPAL,
  type AgentMeta,
  type HiveMessage,
  type HiveTask,
  type HiveTaskStatusEvent,
  type MessageAct,
  type Registry,
  type RegistryAgent,
  type RouterHealth,
  type SpawnInjection,
} from "./types";

const HOP_CAP = 12;
const MINE_IGNORE_LINES = ["settings.json", "cursor.json", "inbox/", "outbox/", ".codex/"];

function sleepSync(ms: number): void {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function shortRand(): string {
  return randomBytes(3).toString("hex");
}

function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
  return p;
}

function ensureMineIgnore(agentDir: string): void {
  const p = join(agentDir, ".gitignore");
  let existing = "";
  try {
    if (existsSync(p)) existing = readFileSync(p, "utf8");
  } catch {
    return;
  }
  const have = new Set(existing.split("\n").map((l) => l.trim()));
  const missing = MINE_IGNORE_LINES.filter((l) => !have.has(l));
  if (missing.length === 0) return;
  const prefix = existing && !existing.endsWith("\n") ? `${existing}\n` : existing;
  try {
    writeFileSync(p, `${prefix}${missing.join("\n")}\n`, "utf8");
  } catch {
    /* best-effort */
  }
}

/** Resuelve la ruta por defecto del hive headless en ISyMCP. */
export function defaultHiveRoot(env: Record<string, string | undefined> = process.env): string {
  const explicit = env.ISYMCP_HIVE_ROOT || env.HIVE_ROOT || env.MUNDER_LINK_HIVE;
  if (explicit && explicit.trim()) return resolve(expandTilde(explicit.trim()));
  return join(bridgeHome(env), "hive");
}

/** Redacta secretos conocidos en texto libre antes de cruzar límites de proceso/red. */
export function redactSecrets(text: unknown): string {
  if (typeof text !== "string" || !text) return typeof text === "string" ? text : "";
  let s = text;
  s = s.replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, "[redacted]");
  s = s.replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, "[redacted]");
  s = s.replace(
    /(?:sk-(?:ant-)?[A-Za-z0-9_-]{16,}|xox[bpaors]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,}|gh[posru]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|AIza[A-Za-z0-9_-]{20,})/g,
    "[redacted]",
  );
  s = s.replace(/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]");
  s = s.replace(
    /\b((?:[a-z0-9]+[_-])*(?:api[_-]?key|secret[_-]?access[_-]?key|secret|token|password|passwd|pwd|access[_-]?token|refresh[_-]?token|client[_-]?secret|signing[_-]?secret|webhook[_-]?secret|auth[_-]?token|bot[_-]?token|private[_-]?key))(\s*[:=]\s*)(["']?)[^\s"',}]{6,}\3/gi,
    (_m, k) => `${k}=[redacted]`,
  );
  return s;
}

/** Repara saltos de línea literales dentro de strings JSON escritos a mano en outbox/. */
export function repairLiteralLineBreaksInJsonStrings(raw: string): { text: string; changed: boolean } {
  let text = "";
  let inString = false;
  let escaped = false;
  let changed = false;

  for (const ch of raw) {
    if (!inString) {
      text += ch;
      if (ch === '"') inString = true;
      continue;
    }
    if (escaped) {
      text += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      text += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      text += ch;
      inString = false;
      continue;
    }
    if (ch === "\n") {
      text += "\\n";
      changed = true;
      continue;
    }
    if (ch === "\r") {
      text += "\\r";
      changed = true;
      continue;
    }
    text += ch;
  }
  return { text, changed };
}

export interface HiveManagerOptions {
  /** Ruta directa al directorio `hive/` (o función perezosa). */
  hiveRoot?: string | (() => string | null);
  /** Si false, desactiva commits git automáticos (útil para tests rápidos o modo solo-disco). */
  gitEnabled?: boolean;
  /** Emisor opcional para observadores externos (sustituye webContents.send de Electron). */
  emit?: (channel: string, payload: unknown) => boolean | void;
}

export class HiveManager {
  private readonly getRootFn: () => string | null;
  private readonly gitEnabled: boolean;
  private readonly emit?: (channel: string, payload: unknown) => boolean | void;

  private routerTimer: ReturnType<typeof setInterval> | null = null;
  private lastRouteAt = 0;
  private routedObservers: Array<(msg: HiveMessage, targets: string[]) => void> = [];
  private taskStatusObservers: Array<(event: HiveTaskStatusEvent) => void> = [];

  constructor(options: HiveManagerOptions = {}) {
    if (typeof options.hiveRoot === "function") {
      this.getRootFn = options.hiveRoot;
    } else if (typeof options.hiveRoot === "string") {
      const resolved = resolve(expandTilde(options.hiveRoot));
      this.getRootFn = () => resolved;
    } else {
      const def = defaultHiveRoot();
      this.getRootFn = () => def;
    }
    this.gitEnabled = options.gitEnabled !== false;
    this.emit = options.emit;
  }

  // ── rutas ──────────────────────────────────────────────────────────────────

  root(): string | null {
    const r = this.getRootFn();
    return r ? resolve(r) : null;
  }

  enabled(): boolean {
    return this.root() !== null;
  }

  safePath(...parts: string[]): string {
    const root = this.root();
    if (!root) throw new Error("hive_disabled");
    const full = resolve(root, ...parts);
    const rel = relative(root, full);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`hive_path_traversal:${parts.join("/")}`);
    }
    return full;
  }

  agentDir(id: string): string {
    if (!id || /[\\/]|^\.\.?$/.test(id)) throw new Error(`invalid_agent_id:${id}`);
    return this.safePath("agents", id);
  }

  /** Endpoint IPC para hooks: UDS en Linux/macOS, Named Pipe privado en Windows. */
  sockPath(): string | null {
    const root = this.root();
    if (!root) return null;
    return localIpcPath(join(root, "hooks.sock"));
  }

  shimPath(): string | null {
    const root = this.root();
    return root ? join(root, "bin", "cth-hook.cjs") : null;
  }

  // ── bootstrap ──────────────────────────────────────────────────────────────

  ensureHive(): void {
    const root = this.root();
    if (!root) return;
    mkdirSync(join(root, "agents"), { recursive: true });
    mkdirSync(join(root, "bin"), { recursive: true });

    const protocol = join(root, "PROTOCOL.md");
    if (!existsSync(protocol)) writeFileSync(protocol, PROTOCOL_MD, "utf8");

    const registry = join(root, "registry.json");
    if (!existsSync(registry)) {
      this.atomicWriteJson(registry, { godId: null, agents: {} } as Registry);
    }

    const board = join(root, "board.md");
    if (!existsSync(board)) {
      writeFileSync(board, "# Hive board\n\n_Shared plans live here. The god agent is the scribe._\n", "utf8");
    }

    const tasks = join(root, "tasks.json");
    if (!existsSync(tasks)) this.atomicWriteJson(tasks, { tasks: [] });

    const log = join(root, "log.jsonl");
    if (!existsSync(log)) writeFileSync(log, "", "utf8");

    const gitignore = join(root, ".gitignore");
    const want = ["fleet.json", "hooks.sock", "cost-ledger.jsonl", "crashes/", ".DS_Store"];
    let lines: string[] = [];
    if (existsSync(gitignore)) {
      try {
        lines = readFileSync(gitignore, "utf8").split("\n");
      } catch {
        lines = [];
      }
    }
    const missing = want.filter((w) => !lines.includes(w));
    if (missing.length) {
      writeFileSync(gitignore, `${[...lines.filter(Boolean), ...missing].join("\n")}\n`, "utf8");
    }

    const shim = this.shimPath()!;
    writeFileSync(shim, HOOK_SHIM, "utf8");
    if (process.platform !== "win32") {
      try {
        chmodSync(shim, 0o755);
      } catch {
        /* best-effort */
      }
    }

    if (this.gitEnabled && !existsSync(join(root, ".git"))) {
      this.git(["init", "-q"], root);
      this.commit("hive: init");
    }
  }

  private cwdValid(cwd: string | undefined): boolean {
    if (!cwd || typeof cwd !== "string") return false;
    const expanded = expandTilde(cwd);
    if (!isAbsolute(expanded)) return false;
    try {
      return statSync(expanded).isDirectory();
    } catch {
      return false;
    }
  }

  ensureAgent(meta: AgentMeta): SpawnInjection {
    const root = this.root();
    if (!root) return { args: [], env: {}, systemPrompt: "" };
    this.ensureHive();

    const dir = this.agentDir(meta.id);
    mkdirSync(join(dir, "inbox", ".done"), { recursive: true });
    mkdirSync(join(dir, "outbox", ".sent"), { recursive: true });
    ensureMineIgnore(dir);

    const cwd = expandTilde(meta.cwd || process.cwd());
    const identityPath = join(dir, "identity.md");
    writeFileSync(identityPath, this.identityText({ ...meta, cwd }), "utf8");

    const memPath = join(dir, "memory.md");
    if (!existsSync(memPath)) {
      writeFileSync(memPath, `# Memory — ${meta.name} (${meta.id})\n\n`, "utf8");
    }

    const cursorPath = join(dir, "cursor.json");
    if (!existsSync(cursorPath)) {
      this.atomicWriteJson(cursorPath, { lastProcessed: null });
    }

    const reg = this.registry();
    const prev = reg.agents[meta.id];
    const nextAgent: RegistryAgent = {
      ...prev,
      ...meta,
      cwd,
      role: meta.role ?? prev?.role ?? (meta.isGod ? "orchestrator (god)" : "agent"),
      status: prev?.status && prev.status !== "gone" ? prev.status : "idle",
      lastSeen: Date.now(),
      archived: false,
      cwdValid: this.cwdValid(cwd),
    };
    reg.agents[meta.id] = nextAgent;
    if (meta.isGod) reg.godId = meta.id;
    this.atomicWriteJson(join(root, "registry.json"), reg);
    this.appendLog({ kind: "agent-ensure", agentId: meta.id, name: meta.name, isGod: !!meta.isGod });
    this.commit(`hive: ensure agent ${meta.id}`);

    const sock = this.sockPath() ?? "";
    const systemPrompt = this.injectedPrompt({ ...meta, cwd }, dir, root);
    const env: Record<string, string> = {
      AGENT_ID: meta.id,
      AGENT_NAME: meta.name,
      HIVE_ROOT: root,
      AGENT_DIR: dir,
      ...(sock ? { HIVE_SOCK: sock } : {}),
    };
    return {
      args: ["--append-system-prompt", systemPrompt],
      env,
      systemPrompt,
    };
  }

  setArchived(id: string, archived: boolean): void {
    const root = this.root();
    if (!root) return;
    const reg = this.registry();
    if (!reg.agents[id]) return;
    reg.agents[id].archived = archived;
    if (archived) reg.agents[id].status = "gone";
    reg.agents[id].lastSeen = Date.now();
    this.atomicWriteJson(join(root, "registry.json"), reg);
    this.commit(`hive: archive ${id}=${archived}`);
  }

  setAgentHold(id: string, onHold: boolean): { ok: boolean; onHold?: boolean; error?: string } {
    const root = this.root();
    if (!root) return { ok: false, error: "hive_disabled" };
    const reg = this.registry();
    if (!reg.agents[id]) return { ok: false, error: "unknown_agent" };
    reg.agents[id].onHold = onHold;
    reg.agents[id].lastSeen = Date.now();
    this.atomicWriteJson(join(root, "registry.json"), reg);
    this.commit(`hive: hold ${id}=${onHold}`);
    return { ok: true, onHold };
  }

  recordSession(agentId: string, sessionId: string): void {
    const root = this.root();
    if (!root || !sessionId) return;
    const reg = this.registry();
    const agent = reg.agents[agentId];
    if (!agent || agent.sessionId === sessionId) return;
    agent.sessionId = sessionId;
    agent.lastSeen = Date.now();
    this.atomicWriteJson(join(root, "registry.json"), reg);
  }

  isGod(agentId: string): boolean {
    const reg = this.registry();
    if (reg.godId && reg.godId === agentId) return true;
    return reg.agents[agentId]?.isGod === true || agentId === "god";
  }

  rosterContext(contextFor?: (id: string) => { tokens: number; limit: number } | undefined): string {
    const reg = this.registry();
    const rows = Object.values(reg.agents)
      .filter((a) => !a.archived)
      .map((a) => {
        const ctx = contextFor?.(a.id);
        const ctxTag =
          ctx && ctx.limit > 0 ? ` ctx ${Math.round((ctx.tokens / ctx.limit) * 100)}%` : "";
        const holdTag = a.onHold ? " [HOLD]" : "";
        return `${a.id}(${a.name},${a.status}${ctxTag}${holdTag},inbox=${this.inboxBacklog(a.id)})`;
      });
    return `LIVE ROSTER: ${rows.length ? rows.join("; ") : "(empty)"}`;
  }

  // ── mensajería y routing ───────────────────────────────────────────────────

  drainForStop(agentId: string): { block: boolean; reason?: string } {
    const dir = this.agentDir(agentId);
    if (!existsSync(dir)) return { block: false };
    const cursorPath = join(dir, "cursor.json");
    const cursor = this.readJson<{ lastProcessed: string | null }>(cursorPath, { lastProcessed: null });
    const fresh = this.inbox(agentId)
      .filter((m) => !cursor.lastProcessed || m.id > cursor.lastProcessed)
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    if (fresh.length === 0) return { block: false };

    cursor.lastProcessed = fresh[fresh.length - 1]!.id;
    this.atomicWriteJson(cursorPath, cursor);
    this.appendLog({ kind: "drain", agentId, count: fresh.length });

    const lines = fresh.map((m) => `- [from ${m.from}, ${m.act}] ${m.subject}: ${m.body}`).join("\n");
    const reason = [
      `You have ${fresh.length} new hive message(s) in your inbox. Address them before finishing:`,
      lines,
      `Open the files in ${join(dir, "inbox")} for full detail, act on each, then move handled ones to ${join(dir, "inbox", ".done")}. Reply via your outbox if a message requires it.`,
    ].join("\n");
    return { block: true, reason };
  }

  private normalize(partial: Partial<HiveMessage>, from: string): HiveMessage {
    const act = (partial.act ?? "inform") as MessageAct;
    return {
      id: `${stamp()}-${shortRand()}`,
      conversation: partial.conversation ?? `conv-${shortRand()}`,
      in_reply_to: partial.in_reply_to ?? null,
      from: partial.from ?? from,
      to: partial.to ?? "god",
      act,
      subject: partial.subject ?? "",
      body: partial.body ?? "",
      hops: typeof partial.hops === "number" ? partial.hops : 0,
      requires_reply: partial.requires_reply ?? ["request", "query", "propose"].includes(act),
      needs_human: partial.needs_human ?? false,
      created_at: partial.created_at ?? new Date().toISOString(),
    };
  }

  private deliver(msg: HiveMessage, toId: string): boolean {
    const root = this.root();
    if (!root) return false;
    const inbox = toId === GPT_PRINCIPAL ? join(root, "gpt", "inbox") : join(this.agentDir(toId), "inbox");
    if (!existsSync(inbox)) return false;
    this.atomicWriteJson(join(inbox, `${msg.id}.json`), msg);
    return true;
  }

  send(partial: Partial<HiveMessage>, from = "system"): HiveMessage {
    this.ensureHive();
    const msg = this.normalize(partial, from);
    this.routeMessage(msg);
    this.commit(`hive: msg ${msg.from}->${msg.to} (${msg.act})`);
    return msg;
  }

  private routeMessage(msg: HiveMessage): void {
    if (msg.hops > HOP_CAP) {
      this.appendLog({ kind: "drop", reason: "hop-cap", from: msg.from, to: msg.to, id: msg.id });
      return;
    }
    const reg = this.registry();
    const godId = reg.godId ?? "god";
    const resolveTo = (to: string): string => (to === "human" || to === "god" ? godId : to);

    const targets =
      msg.to === "broadcast"
        ? Object.values(reg.agents)
            .filter((a) => !a.archived && !a.isAssistant && a.id !== msg.from)
            .map((a) => a.id)
        : [resolveTo(msg.to)].filter((t) => t !== msg.from);

    if (msg.to !== "broadcast" && resolveTo(msg.to) === msg.from) {
      this.appendLog({ kind: "drop", reason: "human-proxy-is-sender", from: msg.from, to: msg.to, id: msg.id });
      this.deliver(
        {
          ...msg,
          to: msg.from,
          subject: `[undeliverable — "${msg.to}" routes to yourself; use blocked+humanQA for human asks] ${msg.subject}`,
        },
        msg.from,
      );
    }

    const delivered: string[] = [];
    for (const t of targets) {
      if (t === GPT_PRINCIPAL) {
        if (this.deliver(msg, t)) {
          delivered.push(t);
          continue;
        }
        this.appendLog({ kind: "drop", reason: "no-inbox", from: msg.from, to: t, id: msg.id });
        this.deliver({ ...msg, to: godId, subject: `[undeliverable — gpt inbox not configured] ${msg.subject}` }, godId);
        continue;
      }
      if (reg.agents[t]?.isAssistant) {
        this.deliver(
          { ...msg, to: godId, subject: `[bounced — "${t}" is send-only assistant] ${msg.subject}` },
          godId,
        );
        continue;
      }
      if (this.deliver(msg, t)) {
        delivered.push(t);
        continue;
      }
      this.appendLog({ kind: "drop", reason: "no-inbox", from: msg.from, to: t, id: msg.id });
      if (t !== godId) {
        this.deliver(
          { ...msg, to: godId, subject: `[undeliverable — no agent "${t}" in hive] ${msg.subject}` },
          godId,
        );
      }
    }

    this.appendLog({
      kind: "message",
      from: msg.from,
      to: msg.to,
      act: msg.act,
      subject: msg.subject,
      id: msg.id,
      delivered,
    });
    this.emit?.("hive:message", {
      id: msg.id,
      from: msg.from,
      to: msg.to,
      act: msg.act,
      subject: msg.subject,
      targets,
      needsHuman: msg.to === "human",
    });
    for (const cb of [...this.routedObservers]) {
      try {
        cb(msg, targets);
      } catch {
        /* observer isolation */
      }
    }
  }

  addRoutedObserver(cb: (msg: HiveMessage, targets: string[]) => void): () => void {
    this.routedObservers.push(cb);
    return () => {
      const idx = this.routedObservers.indexOf(cb);
      if (idx >= 0) this.routedObservers.splice(idx, 1);
    };
  }

  startRouter(intervalMs = 1500): void {
    if (this.routerTimer || !this.enabled()) return;
    this.routerTimer = setInterval(() => {
      try {
        this.routeOnce();
      } catch {
        /* keep alive */
      }
    }, intervalMs);
    this.routerTimer.unref?.();
  }

  stopRouter(): void {
    if (this.routerTimer) {
      clearInterval(this.routerTimer);
      this.routerTimer = null;
    }
  }

  routeOnce(): number {
    const root = this.root();
    if (!root) return 0;
    const agentsDir = join(root, "agents");
    if (!existsSync(agentsDir)) return 0;
    let routed = 0;
    for (const id of readdirSync(agentsDir)) {
      const outbox = join(agentsDir, id, "outbox");
      if (!existsSync(outbox)) continue;
      mkdirSync(join(outbox, ".sent"), { recursive: true });
      for (const f of readdirSync(outbox)) {
        if (!f.endsWith(".json")) continue;
        const full = join(outbox, f);
        try {
          const raw = readFileSync(full, "utf8");
          let partial: Partial<HiveMessage>;
          try {
            partial = JSON.parse(raw) as Partial<HiveMessage>;
          } catch {
            const repaired = repairLiteralLineBreaksInJsonStrings(raw);
            if (!repaired.changed) {
              this.appendLog({ kind: "drop", reason: "malformed-json", from: id, file: f });
              try {
                renameSync(full, join(outbox, ".sent", `bad-${f}`));
              } catch {
                /* noop */
              }
              continue;
            }
            partial = JSON.parse(repaired.text) as Partial<HiveMessage>;
            this.appendLog({ kind: "outbox-repair", from: id, file: f, repair: "literal-line-break" });
          }
          const msg = this.normalize(partial, id);
          msg.from = id;
          this.routeMessage(msg);
          renameSync(full, join(outbox, ".sent", f));
          routed++;
        } catch {
          try {
            renameSync(full, join(outbox, ".sent", `bad-${f}`));
          } catch {
            /* noop */
          }
        }
      }
    }
    if (routed > 0) this.commit(`hive: routed ${routed} message(s)`);
    this.lastRouteAt = Date.now();
    return routed;
  }

  routerHealth(now = Date.now()): RouterHealth {
    let backlog = 0;
    let oldest: number | null = null;
    try {
      const root = this.root();
      const agentsDir = root ? join(root, "agents") : null;
      if (agentsDir && existsSync(agentsDir)) {
        for (const id of readdirSync(agentsDir)) {
          const outbox = join(agentsDir, id, "outbox");
          if (!existsSync(outbox)) continue;
          for (const f of readdirSync(outbox)) {
            if (!f.endsWith(".json")) continue;
            backlog++;
            try {
              const age = now - statSync(join(outbox, f)).mtimeMs;
              if (oldest === null || age > oldest) oldest = age;
            } catch {
              /* ignore */
            }
          }
        }
      }
    } catch {
      /* never throw */
    }
    return { running: this.routerTimer !== null, lastRouteAt: this.lastRouteAt, backlog, oldestBacklogMs: oldest };
  }

  superviseRouter(now = Date.now(), staleAfterMs = 30_000): { rearmed: boolean; drained: number; backlog: number } {
    if (!this.enabled()) return { rearmed: false, drained: 0, backlog: 0 };
    const h = this.routerHealth(now);
    let rearmed = false;
    if (!h.running || (h.backlog > 0 && now - h.lastRouteAt > staleAfterMs)) {
      this.stopRouter();
      this.startRouter();
      rearmed = true;
    }
    let drained = 0;
    if (rearmed && h.backlog > 0) {
      try {
        drained = this.routeOnce();
      } catch {
        /* ignore */
      }
    }
    if (rearmed) {
      this.appendLog({
        kind: "router-supervise",
        rearmed,
        drained,
        backlog: h.backlog,
        oldestBacklogMs: h.oldestBacklogMs,
        lastRouteAt: h.lastRouteAt,
      });
    }
    return { rearmed, drained, backlog: h.backlog };
  }

  // ── lecturas y escrituras del estado ───────────────────────────────────────

  registry(): Registry {
    const root = this.root();
    if (!root) return { godId: null, agents: {} };
    const raw = this.readJson<Record<string, unknown>>(join(root, "registry.json"), {});
    if (raw && typeof raw === "object" && raw.agents && typeof raw.agents === "object" && !Array.isArray(raw.agents)) {
      return {
        godId: typeof raw.godId === "string" ? raw.godId : null,
        agents: raw.agents as Record<string, RegistryAgent>,
      };
    }
    return { godId: null, agents: (raw as Record<string, RegistryAgent>) ?? {} };
  }

  board(): string {
    const root = this.root();
    return root && existsSync(join(root, "board.md")) ? readFileSync(join(root, "board.md"), "utf8") : "";
  }

  writeBoard(markdown: string): void {
    const root = this.root();
    if (!root) return;
    this.ensureHive();
    writeFileSync(join(root, "board.md"), markdown, "utf8");
    this.appendLog({ kind: "board", bytes: Buffer.byteLength(markdown, "utf8") });
    this.commit("hive: update board");
  }

  tasks(): { tasks: HiveTask[] } {
    const root = this.root();
    if (!root) return { tasks: [] };
    const data = this.readJson<{ tasks?: HiveTask[] }>(join(root, "tasks.json"), { tasks: [] });
    return { tasks: Array.isArray(data?.tasks) ? data.tasks : [] };
  }

  writeTasks(tasks: HiveTask[]): void {
    const root = this.root();
    if (!root) return;
    this.ensureHive();
    const p = join(root, "tasks.json");
    const current = this.readJson<{ tasks?: unknown }>(p, { tasks: [] });
    const merged = mergeTaskLedger(current?.tasks, tasks) as HiveTask[];
    this.atomicWriteJson(p, { tasks: merged });
    this.appendLog({ kind: "tasks", count: merged.length });
    this.commit(`hive: tasks (${merged.length})`);

    const prevById = new Map(
      (Array.isArray(current?.tasks) ? current.tasks : [])
        .filter((t): t is HiveTask => !!t && typeof t === "object" && typeof (t as HiveTask).id === "string")
        .map((t) => [t.id, t]),
    );
    for (const task of merged) {
      const prev = prevById.get(task.id);
      if (!prev || prev.status === task.status || (task.status !== "done" && task.status !== "blocked")) continue;
      const ev: HiveTaskStatusEvent = {
        id: `task-status:${task.id}:${task.status}:${Date.now()}`,
        taskId: task.id,
        title: task.title,
        status: task.status,
        ts: Date.now(),
      };
      for (const observer of [...this.taskStatusObservers]) {
        try {
          observer(ev);
        } catch {
          /* ignore */
        }
      }
    }
  }

  addTaskStatusObserver(observer: (event: HiveTaskStatusEvent) => void): () => void {
    this.taskStatusObservers.push(observer);
    return () => {
      const idx = this.taskStatusObservers.indexOf(observer);
      if (idx >= 0) this.taskStatusObservers.splice(idx, 1);
    };
  }

  addTask(task: HiveTask): boolean {
    const tasks = this.tasks().tasks;
    if (tasks.some((t) => t?.id === task.id)) return false;
    this.writeTasks([...tasks, task]);
    return true;
  }

  patchTask(id: string, patch: Partial<Omit<HiveTask, "id">>): boolean {
    const tasks = this.tasks().tasks;
    const idx = tasks.findIndex((t) => t?.id === id);
    if (idx < 0) return false;
    const next = tasks.slice();
    next[idx] = { ...tasks[idx]!, ...patch, id };
    this.writeTasks(next);
    return true;
  }

  deleteTask(id: string): boolean {
    const tasks = this.tasks().tasks;
    const next = tasks.filter((t) => t?.id !== id);
    if (next.length === tasks.length) return false;
    this.writeTasks(next);
    return true;
  }

  memory(id: string): string {
    const p = join(this.agentDir(id), "memory.md");
    return existsSync(p) ? readFileSync(p, "utf8") : "";
  }

  appendMemory(id: string, note: string): void {
    const dir = this.agentDir(id);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "memory.md"), `${note.trimEnd()}\n`, "utf8");
    this.commit(`hive: memory ${id}`);
  }

  inbox(id: string): HiveMessage[] {
    return this.listMessages(join(this.agentDir(id), "inbox"));
  }

  outbox(id: string): HiveMessage[] {
    return this.listMessages(join(this.agentDir(id), "outbox"));
  }

  inboxBacklog(id: string): number {
    const dir = join(this.agentDir(id), "inbox");
    if (!existsSync(dir)) return 0;
    try {
      return readdirSync(dir).filter((f) => f.endsWith(".json")).length;
    } catch {
      return 0;
    }
  }

  logTail(n = 200): unknown[] {
    const root = this.root();
    if (!root) return [];
    const p = join(root, "log.jsonl");
    if (!existsSync(p)) return [];
    const lines = readFileSync(p, "utf8").split("\n").filter(Boolean).slice(-Math.max(1, n));
    return lines.map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { raw: line };
      }
    });
  }

  appendLog(event: Record<string, unknown>): void {
    const root = this.root();
    if (!root) return;
    mkdirSync(root, { recursive: true });
    appendFileSync(
      join(root, "log.jsonl"),
      `${JSON.stringify({ ...event, timestamp: new Date().toISOString() })}\n`,
      "utf8",
    );
  }

  // ── utilidades internas ────────────────────────────────────────────────────

  private listMessages(dir: string): HiveMessage[] {
    if (!existsSync(dir)) return [];
    const out: HiveMessage[] = [];
    for (const f of readdirSync(dir).sort()) {
      if (!f.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(readFileSync(join(dir, f), "utf8")) as HiveMessage;
        if (parsed && typeof parsed === "object") out.push(parsed);
      } catch {
        /* ignore malformed */
      }
    }
    return out;
  }

  private readJson<T>(filePath: string, fallback: T): T {
    try {
      if (!existsSync(filePath)) return fallback;
      const raw = readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  private atomicWriteJson(filePath: string, data: unknown): void {
    mkdirSync(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp-${shortRand()}`;
    try {
      writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
      renameSync(tmp, filePath);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
  }

  private identityText(meta: AgentMeta): string {
    const caps = (meta.capabilities ?? []).join(", ") || "—";
    return [
      `# ${meta.name} (${meta.id})`,
      "",
      `- Role: ${meta.role ?? (meta.isGod ? "orchestrator (god)" : "agent")}`,
      `- Capabilities: ${caps}`,
      `- Working directory: ${meta.cwd}`,
      meta.isGod
        ? "- You are the **god / orchestrator**. Decompose work, keep board.md and tasks.json accurate, and delegate to agents."
        : "",
      "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  private injectedPrompt(meta: AgentMeta, dir: string, root: string): string {
    return [
      `You are "${meta.name}" (${meta.id}), an autonomous agent in an ISyMCP headless Hive.`,
      `Your workspace: ${dir}. Shared hive: ${root}. Protocol: ${join(root, "PROTOCOL.md")}.`,
      "",
      "HIVE PROTOCOL:",
      `1. Read ${join(dir, "memory.md")} and every JSON file in ${join(dir, "inbox")}. Move handled messages to ${join(dir, "inbox", ".done")}.`,
      `2. Record durable facts by appending to ${join(dir, "memory.md")}.`,
      `3. To message another agent, drop one JSON file into ${join(dir, "outbox")} (never write into another agent's directory).`,
      meta.isGod
        ? "4. You are the god/orchestrator: maintain board.md (sole scribe) and tasks.json."
        : '4. For ambiguities or sign-offs, send a message with "to": "god".',
      "Env vars: AGENT_ID, AGENT_NAME, HIVE_ROOT, AGENT_DIR, HIVE_SOCK.",
    ].join("\n");
  }

  // ── single-committer git ───────────────────────────────────────────────────

  private git(args: string[], cwd: string): { ok: boolean; out: string; err: string } {
    const res = spawnSync(
      "git",
      [
        "-c",
        "commit.gpgsign=false",
        "-c",
        "gc.autoDetach=false",
        "-c",
        "user.name=ISyMCP Hive",
        "-c",
        "user.email=hive@isymcp.local",
        ...args,
      ],
      { cwd, encoding: "utf8", timeout: 8000 },
    );
    return { ok: res.status === 0, out: res.stdout ?? "", err: res.stderr ?? "" };
  }

  commit(message: string): void {
    if (!this.gitEnabled) return;
    const root = this.root();
    if (!root || !existsSync(join(root, ".git"))) return;
    for (let attempt = 0; attempt < 5; attempt++) {
      this.clearStaleLock(root);
      const add = this.git(["add", "-A"], root);
      const commit = this.git(["commit", "-q", "-m", message], root);
      if (commit.ok) return;
      if (/nothing to commit/i.test(commit.out + commit.err)) return;
      if (!add.ok || /index\.lock/i.test(commit.err)) {
        sleepSync(50 * (attempt + 1));
        continue;
      }
      return;
    }
  }

  private clearStaleLock(root: string): void {
    const STALE_MS = 10_000;
    try {
      for (const lock of ["index.lock", "HEAD.lock"]) {
        const p = join(root, ".git", lock);
        if (existsSync(p) && Date.now() - statSync(p).mtimeMs > STALE_MS) rmSync(p);
      }
    } catch {
      /* noop */
    }
  }
}

const PROTOCOL_MD = `# ISyMCP Hive Protocol (Headless)

Coordination is file-based inside the shared hive directory. Only the ISyMCP Hive
daemon runs git commits and moves messages from outboxes to inboxes.

## Workspace — \`agents/<your-id>/\`
- \`identity.md\`  — your role and capabilities.
- \`memory.md\`    — durable memory (read at start, append as you learn).
- \`inbox/\`       — incoming JSON messages. Move handled ones to \`inbox/.done/\`.
- \`outbox/\`      — drop outgoing JSON messages here; the router delivers them.

## Message JSON
\`\`\`json
{
  "to": "<agent-id> | god | broadcast",
  "act": "request | inform | propose | query | agree | refuse | done",
  "subject": "short summary",
  "body": "details"
}
\`\`\`

Only \`request\`, \`query\`, and \`propose\` expect a reply. \`inform\` and \`done\` are terminal.
`;

const HOOK_SHIM = `#!/usr/bin/env node
'use strict';
const net = require('net');
const isStatus = process.argv.includes('--status');
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { data += d; });
process.stdin.on('end', () => {
  let payload = {};
  try { payload = JSON.parse(data || '{}'); } catch (_) {}
  if (!payload.agent_id) payload.agent_id = process.env.AGENT_ID || null;
  const sock = process.env.HIVE_SOCK;
  if (isStatus) {
    payload.hook_event_name = 'Status';
    const cw = payload.context_window || {};
    if (typeof cw.total_input_tokens === 'number' && typeof cw.context_window_size === 'number' && cw.context_window_size > 0) {
      const pct = Math.round((cw.total_input_tokens / cw.context_window_size) * 100);
      process.stdout.write('ctx ' + Math.round(cw.total_input_tokens / 1000) + 'k/' + Math.round(cw.context_window_size / 1000) + 'k (' + pct + '%)');
    }
    if (sock) {
      try {
        const c = net.createConnection(sock, () => { c.end(JSON.stringify(payload) + '\\n'); });
        c.on('error', () => {});
        c.on('close', () => process.exit(0));
      } catch (_) { process.exit(0); }
    } else {
      process.exit(0);
    }
    setTimeout(() => process.exit(0), 1500).unref();
    return;
  }
  if (!sock) { process.exit(0); }
  let resp = '';
  const done = (code) => { if (resp) process.stdout.write(resp); process.exit(code); };
  const c = net.createConnection(sock, () => c.write(JSON.stringify(payload) + '\\n'));
  c.setEncoding('utf8');
  c.on('data', (d) => { resp += d; });
  c.on('end', () => done(0));
  c.on('error', () => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
});
`;
