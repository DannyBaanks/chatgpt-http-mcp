// src/cli/commands/hive.ts — CLI headless del Hive (`isymcp hive ...`, cero Electron).
import type { CliModule } from "../module";
import { defaultHiveRoot, HiveManager } from "../../hive/manager";
import { startHiveDaemon } from "../../hive/daemon";
import type { MessageAct } from "../../hive/types";
import { runRelay, type RelayOptions } from "../../hive/relay";

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function hiveHelp(): void {
  console.log(`isymcp hive — Coordinación multi-agente headless (sin GUI)

Uso:
  isymcp hive init [--root <dir>]
  isymcp hive start [--root <dir>] [--drain-on-stop]
  isymcp hive status [--root <dir>]
  isymcp hive agents [--root <dir>]
  isymcp hive tasks [--root <dir>]
  isymcp hive board [--root <dir>]
  isymcp hive send <to> <subject> <body> [--from <id>] [--act <act>] [--root <dir>]
  isymcp hive logs [--tail <n>] [--root <dir>]
  isymcp hive relay <agent_id> --tmux <session> [--socket <tmux -L>] [--root <dir>]
  isymcp hive relay <agent_id> [--cwd <dir>] [--timeout-ms <n>] [--reply-from <id>] -- <cli headless...>

relay: cada mensaje que llega al inbox de <agent_id> se le entrega solo.
  --tmux  lo pega en su TUI viva (el agente contesta con hive_talk).
  -- cmd  lanza el CLI headless con el mensaje por stdin y devuelve su stdout al remitente
          (ej.: -- claude -p   |   -- gemini -p   |   -- codex exec -).`);
}

export const hiveModule: CliModule = {
  names: ["hive"],
  async run(sub, rest) {
    const root = flagValue(rest, "--root") ?? defaultHiveRoot();
    if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
      hiveHelp();
      return;
    }

    const hive = new HiveManager({ hiveRoot: root });

    switch (sub) {
      case "init": {
        hive.ensureHive();
        console.log(JSON.stringify({ ok: true, hive_root: hive.root(), sock_path: hive.sockPath() }, null, 2));
        return;
      }

      case "start": {
        const daemon = await startHiveDaemon({
          hiveRoot: root,
          drainOnStop: rest.includes("--drain-on-stop"),
        });
        console.log(`[isymcp-hive] headless activo en ${daemon.hive.root()} (ipc: ${daemon.sockPath})`);
        await new Promise<void>((resolve) => {
          const bye = () => {
            daemon.stop();
            resolve();
          };
          process.once("SIGINT", bye);
          process.once("SIGTERM", bye);
        });
        return;
      }

      case "status": {
        const reg = hive.registry();
        const tasks = hive.tasks().tasks;
        console.log(
          JSON.stringify(
            {
              hive_root: hive.root(),
              sock_path: hive.sockPath(),
              god_id: reg.godId,
              agents_total: Object.keys(reg.agents).length,
              tasks_total: tasks.length,
              tasks_open: tasks.filter((t) => t.status !== "done").length,
              router: hive.routerHealth(),
            },
            null,
            2,
          ),
        );
        return;
      }

      case "agents": {
        console.log(JSON.stringify(hive.registry(), null, 2));
        return;
      }

      case "tasks": {
        console.log(JSON.stringify(hive.tasks(), null, 2));
        return;
      }

      case "board": {
        console.log(hive.board());
        return;
      }

      case "send": {
        const positional = rest.filter((a, idx) => {
          if (a.startsWith("--")) return false;
          const prev = rest[idx - 1];
          return prev !== "--root" && prev !== "--from" && prev !== "--act";
        });
        const [to, subject, ...bodyParts] = positional;
        if (!to || !subject) {
          console.error("Uso: isymcp hive send <to> <subject> <body> [--from <id>] [--act <act>]");
          process.exit(2);
        }
        const from = flagValue(rest, "--from") ?? "operator";
        const act = (flagValue(rest, "--act") ?? "request") as MessageAct;
        const msg = hive.send({ to, act, subject, body: bodyParts.join(" ") }, from);
        console.log(JSON.stringify({ ok: true, message: msg }, null, 2));
        return;
      }

      case "logs": {
        const tail = Number(flagValue(rest, "--tail") ?? 50);
        console.log(JSON.stringify(hive.logTail(Number.isFinite(tail) ? tail : 50), null, 2));
        return;
      }

      case "relay": {
        const dd = rest.indexOf("--");
        const head = dd >= 0 ? rest.slice(0, dd) : rest;
        const execArgv = dd >= 0 ? rest.slice(dd + 1) : [];
        const valued = new Set(["--root", "--tmux", "--socket", "--cwd", "--timeout-ms", "--reply-from"]);
        const agentId = head.find((a, i) => !a.startsWith("--") && !valued.has(head[i - 1] ?? ""));
        const tmuxSession = flagValue(head, "--tmux");
        if (!agentId || (!tmuxSession && execArgv.length === 0) || (tmuxSession && execArgv.length > 0)) {
          console.error("Uso: isymcp hive relay <agent_id> (--tmux <session> | -- <cli headless...>)");
          process.exit(2);
        }
        const timeout = Number(flagValue(head, "--timeout-ms") ?? 600_000);
        const opts: RelayOptions = {
          agentId,
          mode: tmuxSession ? "tmux" : "exec",
          tmuxSession,
          tmuxSocket: flagValue(head, "--socket"),
          execArgv,
          execCwd: flagValue(head, "--cwd"),
          execTimeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 600_000,
          replyFrom: flagValue(head, "--reply-from"),
        };
        const ac = new AbortController();
        process.once("SIGINT", () => ac.abort());
        process.once("SIGTERM", () => ac.abort());
        console.log(
          `[isymcp-hive-relay] ${agentId} (${opts.mode}${tmuxSession ? ` → tmux ${tmuxSession}` : ` → ${execArgv.join(" ")}`}) escuchando en ${hive.root()}`,
        );
        await runRelay(hive, opts, {
          signal: ac.signal,
          onOutcome: (o) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...o })),
        });
        return;
      }

      default:
        hiveHelp();
        process.exit(2);
    }
  },
};
