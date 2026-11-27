// src/hive/hooks-server.ts — Servidor de hooks headless para el Hive (UDS en Linux, Named Pipe en Windows).
// Extraído de isyco-worlds/src/main/hooks.ts eliminando por completo Electron.
import { createServer, type Server } from "node:net";
import { existsSync, rmSync } from "node:fs";
import { isWindowsPipePath } from "../platform/ipc";
import { GUARDED_TOOLS, hiveWriteDecision } from "./guard";
import type { HiveManager } from "./manager";
import type { HookPayload } from "./types";

const MAX_HOOK_FRAME_BYTES = 256 * 1024;

export interface HeadlessHookServerOptions {
  /** Si true, un Stop hook con mensajes sin leer devuelve `{ decision: "block", reason }`. */
  drainOnStop?: boolean;
  /** Callback opcional para observar cada evento recibido. */
  onEvent?: (agentId: string | undefined, event: string, payload: HookPayload) => void;
  /** Callback opcional para objetivo persistente de cada agente. */
  getStandingGoal?: (agentId: string) => string | null;
}

export class HiveHookServer {
  private server: Server | null = null;
  private transcriptPaths = new Map<string, string>();
  private contextById = new Map<string, { tokens: number; limit: number; ts: number }>();
  private deliveredGoalByAgent = new Map<string, { sessionId: string | null; goal: string | null }>();

  constructor(
    private readonly hive: HiveManager,
    private readonly opts: HeadlessHookServerOptions = {},
  ) {}

  start(): Promise<string | null> {
    const sock = this.hive.sockPath();
    if (!sock || this.server) return Promise.resolve(sock);
    if (!isWindowsPipePath(sock)) {
      try {
        if (existsSync(sock)) rmSync(sock);
      } catch {
        /* noop */
      }
    }

    return new Promise((resolve, reject) => {
      const srv = createServer((conn) => {
        let pending = Buffer.alloc(0);
        const rejectOversized = (bytes: number): void => {
          this.hive.appendLog({
            kind: "hook-frame-rejected",
            reason: "frame-too-large",
            bytes,
            limit: MAX_HOOK_FRAME_BYTES,
          });
          conn.destroy();
        };

        conn.on("data", (chunk) => {
          const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
          pending = Buffer.concat([pending, buf]);
          const nl = pending.indexOf(0x0a);
          if (nl === -1) {
            if (pending.length > MAX_HOOK_FRAME_BYTES) rejectOversized(pending.length);
            return;
          }
          if (nl > MAX_HOOK_FRAME_BYTES) {
            rejectOversized(nl);
            return;
          }
          const frame = pending.subarray(0, nl).toString("utf8");
          let payload: HookPayload = {};
          try {
            payload = JSON.parse(frame) as HookPayload;
          } catch {
            /* ignore */
          }
          let res: unknown = {};
          try {
            res = this.handle(payload);
          } catch {
            res = {};
          }
          conn.end(JSON.stringify(res ?? {}));
        });
        conn.on("error", () => {
          /* ignore client disconnect */
        });
      });

      srv.once("error", reject);
      srv.listen(sock, () => {
        this.server = srv;
        resolve(sock);
      });
    });
  }

  stop(): void {
    try {
      this.server?.close();
    } catch {
      /* noop */
    }
    this.server = null;
    const sock = this.hive.sockPath();
    if (sock && !isWindowsPipePath(sock)) {
      try {
        if (existsSync(sock)) rmSync(sock);
      } catch {
        /* noop */
      }
    }
  }

  transcriptPath(agentId: string): string | undefined {
    return this.transcriptPaths.get(agentId);
  }

  contextFor(agentId: string): { tokens: number; limit: number; ts: number } | undefined {
    return this.contextById.get(agentId);
  }

  handle(p: HookPayload): unknown {
    const agentId = p.agent_id ?? undefined;
    const event = p.hook_event_name ?? "Unknown";
    this.opts.onEvent?.(agentId, event, p);

    if (agentId && typeof p.transcript_path === "string" && p.transcript_path) {
      this.transcriptPaths.set(agentId, p.transcript_path);
    }

    if (event === "Status") {
      const cw = p.context_window;
      if (
        agentId &&
        cw &&
        typeof cw.total_input_tokens === "number" &&
        typeof cw.context_window_size === "number" &&
        cw.context_window_size > 0
      ) {
        this.contextById.set(agentId, {
          tokens: cw.total_input_tokens,
          limit: cw.context_window_size,
          ts: Date.now(),
        });
      }
      return {};
    }

    if (agentId && p.session_id) {
      this.hive.recordSession(agentId, p.session_id);
    }

    if ((event === "Stop" || event === "SubagentStop") && agentId) {
      if (p.stop_hook_active) return {};
      if (this.opts.drainOnStop) {
        const drained = this.hive.drainForStop(agentId);
        if (drained.block) return { decision: "block", reason: drained.reason };
      }
      return {};
    }

    if (event === "PreToolUse" && agentId && GUARDED_TOOLS.has(p.tool_name ?? "")) {
      const hiveRoot = this.hive.root();
      if (hiveRoot) {
        const d = hiveWriteDecision({
          tool: p.tool_name ?? "",
          toolInput: p.tool_input,
          cwd: p.cwd,
          agentId,
          isGod: this.hive.isGod(agentId),
          hiveRoot,
          caseInsensitive: process.platform !== "linux",
        });
        if (d.deny) {
          return {
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: d.reason,
            },
          };
        }
      }
    }

    const wantsRoster =
      (event === "SessionStart" || event === "UserPromptSubmit") && !!agentId && this.hive.isGod(agentId);
    const roster = wantsRoster ? this.hive.rosterContext((id) => this.contextFor(id)) : null;

    const wantsGoal = (event === "SessionStart" || event === "UserPromptSubmit") && !!agentId;
    const goalRaw = wantsGoal ? (this.opts.getStandingGoal?.(agentId) ?? null) : null;
    let goal: string | null = null;
    if (wantsGoal) {
      const sessionId = p.session_id ?? null;
      const delivered = this.deliveredGoalByAgent.get(agentId);
      const newSession = !delivered || delivered.sessionId !== sessionId;
      const changed = !!delivered && delivered.sessionId === sessionId && delivered.goal !== goalRaw;
      if (event === "SessionStart" || newSession || changed) {
        this.deliveredGoalByAgent.set(agentId, { sessionId, goal: goalRaw });
        if (goalRaw) goal = `<goal>\n${goalRaw}\n</goal>`;
      }
    }

    if (roster || goal) {
      return {
        hookSpecificOutput: {
          hookEventName: event,
          additionalContext: [roster, goal].filter(Boolean).join("\n\n"),
        },
      };
    }

    return {};
  }
}
