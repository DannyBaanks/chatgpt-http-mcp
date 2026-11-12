// src/cli/commands/canary.ts — `isymcp canary run|status|schedule|unschedule`.
import { confirm } from "../../cli/args";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sh } from "../services";
import { status } from "./status";
import { ROOT } from "../root";
import type { CliModule } from "../module";

export async function canaryScheduleInteractive(sub: "schedule" | "unschedule"): Promise<void> {
  await canaryCommand(sub, []);
  if (await confirm("¿Aplicar?")) await canaryCommand(sub, ["--apply"]);
  else console.log("nada tocado");
}

// canary run|status|schedule|unschedule — ¿la captura sigue viva contra el
// chatgpt.com de hoy? schedule/unschedule sin --apply solo muestran.
export async function canaryCommand(sub: string, rest: string[]): Promise<void> {
  const { notifyFailure, readLatestCanary, runCanary } = await import("../../canary");
  const show = (r: NonNullable<ReturnType<typeof readLatestCanary>>) => {
    console.log(`canario ${r.ok ? "OK ✓" : "FALLO ✗"} · ${r.ts} · bridge=${r.bridge}`);
    for (const c of r.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name.padEnd(9)} ${(c.ms / 1000).toFixed(1)} s · ${c.detail}`);
    if (r.notice) {
      console.log(`  Origen: ${r.notice.source} / ${r.notice.component} · ${r.notice.severity} · ${r.notice.event}`);
      console.log(`  ${r.notice.summary}`);
      console.log(`  Evidencia: ${r.notice.evidence_ref}`);
      if (r.notice.action) console.log(`  Accion: ${r.notice.action}`);
    } else if (r.error) console.log(`  error: ${r.error}`);
  };
  if (sub === "run") {
    const result = await runCanary();
    show(result);
    await notifyFailure(result);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (sub === "status") {
    const r = readLatestCanary();
    if (!r) { console.log("sin resultados todavia: isymcp canary"); return; }
    show(r);
    return;
  }
  if (sub !== "schedule" && sub !== "unschedule") throw new Error("uso: isymcp canary [run|status|schedule|unschedule] [--apply]");
  const home = process.env.CODEX_WEB_HTTP_HOME?.trim() || join(homedir(), ".codex-web-http");
  const unitDir = join(homedir(), ".config", "systemd", "user");
  const launcher = join(home, "bin", process.platform === "win32" ? "isymcp-canary.ps1" : "isymcp-canary");
  const service = `[Unit]\nDescription=ISyMCP canario (captura de chatgpt.com)\n\n[Service]\nType=oneshot\nExecStart=${launcher}\n`;
  const timer =
    (`[Unit]\nDescription=ISyMCP canario diario\n\n[Timer]\nOnCalendar=*-*-* 09:00:00\nPersistent=true\nRandomizedDelaySec=10m\n\n[Install]\nWantedBy=timers.` +
      `target\n`);
  const windows = process.platform === "win32";
  const steps = windows
    ? sub === "schedule"
      ? [`escribir ${launcher} con ACL privada`, `crear tarea diaria de Windows a las 09:00 (solo cuando el usuario inicio sesion)`]
      : [`eliminar tarea de Windows "ISyMCP Canary"`, `borrar ${launcher}`]
    : sub === "schedule"
      ? [`escribir ${launcher} (lanzador sin espacios)`, `escribir ${join(unitDir, "isymcp-canary.service")}`, `escribir ${join(unitDir,
        "isymcp-canary.timer")} (diario 09:00, Persistent)`, "systemctl --user daemon-reload", "systemctl --user enable --now isymcp-canary.timer"]
      : ["systemctl --user disable --now isymcp-canary.timer", `borrar ${join(unitDir, "isymcp-canary.service")} y .timer`, "systemctl --user daemon-reload"];
  if (!rest.includes("--apply")) {
    console.log(`PLAN (${sub}) — no se toco nada. Repite con --apply:`);
    for (const step of steps) console.log(`  · ${step}`);
    return;
  }
  if (windows) {
    const { installWindowsCanaryTask, removeWindowsCanaryTask } = await import("../../platform/canary-scheduler");
    if (sub === "schedule") installWindowsCanaryTask({ home, bunPath: process.execPath, entryPath: join(ROOT, "src", "isymcp.ts") });
    else removeWindowsCanaryTask(home);
    console.log(sub === "schedule" ? "tarea activa: Windows Task Scheduler · diario 09:00 · usuario conectado" : "tarea quitada");
    return;
  }
  const { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } = await import("node:fs");
  const sh = (argv: string[]) => { const p = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" }); if (p.exitCode !== 0) throw new Error(`${
    argv.join(" ")}: ${p.stderr.toString().trim()}`); };
  if (sub === "schedule") {
    mkdirSync(join(launcher, ".."), { recursive: true });
    const script = join(ROOT, "src", "isymcp.ts");
    writeFileSync(launcher, `#!/usr/bin/env bash\n# generado por isymcp canary schedule\nexec ${JSON.stringify(process.execPath)} run '${script.replace(/'/g,
      `'\\''`)}' canary run\n`, { mode: 0o700 });
    chmodSync(launcher, 0o700);
    mkdirSync(unitDir, { recursive: true });
    writeFileSync(join(unitDir, "isymcp-canary.service"), service);
    writeFileSync(join(unitDir, "isymcp-canary.timer"), timer);
    sh(["systemctl", "--user", "daemon-reload"]);
    sh(["systemctl", "--user", "enable", "--now", "isymcp-canary.timer"]);
    console.log("timer activo: systemctl --user list-timers isymcp-canary.timer");
  } else {
    Bun.spawnSync(["systemctl", "--user", "disable", "--now", "isymcp-canary.timer"]);
    for (const f of ["isymcp-canary.service", "isymcp-canary.timer"]) if (existsSync(join(unitDir, f))) rmSync(join(unitDir, f));
    sh(["systemctl", "--user", "daemon-reload"]);
    console.log("timer quitado");
  }
}

export const canaryModule: CliModule = { names: ["canary"], run: (sub, rest) => canaryCommand(sub ?? "run", rest) };
