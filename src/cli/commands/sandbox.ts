// src/cli/commands/sandbox.ts — `isymcp sandbox|shell exec|wizard|stop|status`:
// wizard interactivo paso a paso (o modo directo con flags) que levanta túnel + permiso shell (total, acotado o apagado)
// + sesión sandbox bwrap y escupe el prompt listo para pegar en ChatGPT.
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { CliModule } from "../module";
import { ask, flag } from "../args";
import {
  isExpired,
  listUserSessions,
  mintSession,
  revokeSession,
  sandboxAvailable,
  sandboxLabel,
  sandboxUnavailableReason,
} from "../../codex-sessions";
import { CONNECTOR_NAME, MENTION } from "../../mcp/identity";
import { select, type MenuItem } from "../../menu";
import {
  MAX_TTL_MS,
  ONCE_MAX_TTL_MS,
  ONCE_MAX_USES,
  appendAudit,
  fileGrant,
  grantOnce,
  parseDuration,
  pendingOnceGrants,
  permissionSource,
  setPermission,
} from "../../permissions";
import { serverUp, startServer, stopServer, tunnel, tunnelState } from "../services";

const DEFAULT_FOR = "4h";
const DEFAULT_LABEL = "gpt-sandbox";

export const SANDBOX_HELP = `isymcp sandbox / isymcp shell — setup guiado (o directo) de sandbox + shell_exec + prompt para ChatGPT

  isymcp shell exec               abre el wizard interactivo paso a paso (elige carpeta, bwrap rw/ro,
  isymcp sandbox exec             shell total/acotado/apagado, horas, tools y tarea -> escupe el prompt)

  isymcp sandbox exec [opciones]  modo directo sin preguntas (o añade --wizard para forzar el wizard):
    --cwd <dir>          directorio de trabajo del sandbox (por defecto: cwd actual)
    --for <duración>     TTL de la sesión y del permiso shell (ej. 30m, 2h, 4h, 12h; máx 24h; defecto 4h)
    --label <nombre>     etiqueta de la sesión (por defecto: gpt-sandbox)
    --ro, --read-only    sesión bwrap en solo lectura (por defecto: escritura en workspace)
    --shell-uses <1..10> shell_exec acotado a N usos puntuales (allow once, caduca máx 1h) en vez de abierto por tiempo
    --no-shell           no encender shell_exec en el host (solo codex_exec en sandbox bwrap)
    --no-up              no levantar server ni conectar el túnel (asume que ya están arriba)
    --reconnect          forzar reconexión del túnel aunque ya esté ready
    --task "<texto>"     tarea inicial personalizada al final del prompt
    --yes, -y            usar valores por defecto sin abrir el wizard
    --wizard, -i         forzar el asistente interactivo paso a paso
    --prompt-only        imprime SOLO el prompt en stdout (ideal para copiar al portapapeles)
    --json               salida estructurada JSON en stdout

  isymcp sandbox stop [fp] [--down]
    apaga shell_exec y revoca la sesión <fp> (o las sesiones activas 'gpt-sandbox');
    con --down también detiene el túnel y el server

  isymcp sandbox status [--json]
    muestra el estado del sandbox bwrap, permiso shell_exec, túnel y sesiones vivas`;

export interface DetectedAgentTools {
  isymem: boolean;
  rtk: boolean;
  ziggrep: boolean;
}

export type ShellAccessMode = "full" | "once" | "none";

export interface SandboxExecConfig {
  cwd: string;
  ttlMs: number;
  label: string;
  writable: boolean;
  shellMode: ShellAccessMode;
  shellUses: number;
  tools: DetectedAgentTools;
  task?: string;
  skipUp: boolean;
  reconnect: boolean;
  promptOnly: boolean;
  asJson: boolean;
}

export function detectAgentTools(pathEnv: string = process.env.PATH ?? ""): DetectedAgentTools {
  const has = (bin: string) => Boolean(Bun.which(bin, { PATH: pathEnv }));
  return {
    isymem: has("isymem"),
    rtk: has("rtk"),
    ziggrep: has("ziggrep"),
  };
}

export interface SandboxPromptOptions {
  cwd: string;
  token: string;
  writable: boolean;
  shellEnabled: boolean;
  shellMode?: ShellAccessMode;
  shellUses?: number;
  tools: DetectedAgentTools;
  task?: string;
}

export function buildSandboxAgentPrompt(opts: SandboxPromptOptions): string {
  const mode: ShellAccessMode = opts.shellMode ?? (opts.shellEnabled ? "full" : "none");
  const hasShell = mode !== "none";
  const sections: string[] = [];
  let n = 1;

  if (opts.tools.isymem && hasShell) {
    sections.push([
      `${n++}. Memoria compartida (\`isymem\` — en \`shell_exec\`, con cwd=${opts.cwd}):`,
      "   - L1: `isymem projects` y `isymem <proyecto>` para ver tarjetas de proyectos.",
      "   - L2: `isymem <proyecto> --open --rules` para ver todos/fails/reglas abiertos (1 línea por hecho).",
      "   - L3: `isymem show <slug>` solo cuando necesites el detalle completo, o `isymem recall \"<tema>\"`.",
      "   - Para anotar hallazgos: `isymem add <proyecto> --todo|--fail|--state|--idea \"<una línea>\"`.",
    ].join("\n"));
  }

  if (opts.tools.rtk) {
    const where = hasShell ? "funciona tanto en `shell_exec` como en `codex_exec`" : "disponible dentro de `codex_exec`";
    sections.push([
      `${n++}. Salida compacta (\`rtk\` — ${where}):`,
      "   - Prefija comandos ruidosos con `rtk` (ej. `rtk git status`, `rtk git diff`, `rtk ls`, `rtk find`, `rtk read <archivo>`).",
      "   - Puedes ver el ahorro acumulado real de la máquina con `rtk gain`.",
    ].join("\n"));
  }

  if (opts.tools.ziggrep && hasShell) {
    sections.push(
      `${n++}. Búsqueda de código (\`ziggrep\` — en \`shell_exec\`, siempre pasando ruta, p. ej. \`ziggrep -n PATRON .\`).`,
    );
  }

  const execLines = [
    `${n++}. Ejecución:`,
    `   - Usa \`codex_exec\` (sandbox ${opts.writable ? "bwrap-workspace-write" : "bwrap-read-only"}) cuando quieras probar cosas aisladas dentro de ${opts.cwd}.`,
  ];
  if (mode === "full") {
    const extras = [opts.tools.isymem && "`isymem`", opts.tools.ziggrep && "`ziggrep`", opts.tools.rtk && "`rtk`"]
      .filter(Boolean)
      .join(", ");
    execLines.push(
      `   - Usa \`shell_exec\` (con \`cwd: ${JSON.stringify(opts.cwd)}\`) para ${extras || "comandos del host"} con acceso completo al entorno.`,
    );
  } else if (mode === "once") {
    const uses = opts.shellUses ?? 1;
    execLines.push(
      `   - \`shell_exec\` está **acotado a ${uses} uso(s)** puntuales: encadena comandos en una sola llamada cuando necesites \`isymem\`/\`ziggrep\`, y usa \`codex_exec\` (sandbox) para todo lo demás.`,
    );
  } else {
    execLines.push("   - `shell_exec` está apagado en esta sesión: trabaja únicamente con `codex_exec` (y `codex_apply_patch` si es writable) dentro del sandbox.");
  }
  sections.push(execLines.join("\n"));

  const defaultTask = hasShell && opts.tools.isymem && opts.tools.rtk
    ? "Para empezar: llama `codex_turn_start`, luego en `shell_exec` corre `isymem projects`, `isymem isymcp --open` y `rtk gain` para ver cómo trabajamos aquí, y dime qué encontraste."
    : hasShell && opts.tools.rtk
      ? `Para empezar: llama \`codex_turn_start\`, luego corre \`rtk ls\` y \`rtk gain\` en ${opts.cwd} y dime el estado del workspace.`
      : `Para empezar: llama \`codex_turn_start\`, revisa el workspace ${opts.cwd} con \`codex_exec\` y dime qué encontraste.`;

  const taskLine = opts.task?.trim() ? `Tarea: ${opts.task.trim()}` : defaultTask;

  return [
    `Trabaja como un agente local en ${opts.cwd} usando el mismo flujo de herramientas que las demás TUIs de esta máquina:`,
    "",
    sections.join("\n\n"),
    "",
    taskLine,
    "",
    `COMANDO: ${MENTION}`,
    `turn_token: ${opts.token}`,
    "Primero llama codex_turn_start y lee bootstrap.content.",
  ].join("\n");
}

function formatTtl(ms: number): string {
  const mins = Math.max(1, Math.round(ms / 60_000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

/** Acepta "4h", "30m", "1d" o un número pelón de horas ("4", "1.5" -> "4h", "1.5h"). */
export function parseFlexDuration(raw: string | undefined): number {
  const trimmed = (raw ?? DEFAULT_FOR).trim();
  const normalized = /^\d+(?:\.\d+)?$/.test(trimmed) ? `${trimmed}h` : trimmed;
  const ms = parseDuration(normalized);
  if (ms === null) {
    throw new Error(`duración no entendida: '${trimmed}' (usa horas como 4 o formatos 30m, 2h, 4h, 1d)`);
  }
  if (ms > MAX_TTL_MS) {
    throw new Error("--for máximo 24h para sandbox exec");
  }
  return ms;
}

export interface WizardIO {
  ask: (question: string) => Promise<string>;
  select: (message: string, choices: MenuItem[]) => Promise<number>;
  log: (line: string) => void;
}

const defaultWizardIO: WizardIO = {
  ask,
  select,
  log: (line) => console.log(line),
};

/** Asistente paso a paso para armar el sandbox + shell_exec sin memorizar flags. Devuelve null si el usuario cancela. */
export async function runSandboxWizard(
  defaults: { cwd?: string; tools?: DetectedAgentTools } = {},
  io: WizardIO = defaultWizardIO,
): Promise<SandboxExecConfig | null> {
  const defaultCwd = resolve(defaults.cwd ?? process.cwd());
  const detected = defaults.tools ?? detectAgentTools();

  io.log("");
  io.log("⚡ Asistente de Sandbox + shell_exec para ChatGPT (Codex ISyMCP)");
  io.log("   (Enter acepta el valor por defecto · Esc/q cancela sin tocar nada)\n");

  // Paso 1/6: Workspace
  let cwd = defaultCwd;
  for (;;) {
    const rawCwd = await io.ask(`1/6 Carpeta de trabajo [${defaultCwd}]: `);
    const candidate = resolve(rawCwd || defaultCwd);
    if (existsSync(candidate) && statSync(candidate).isDirectory()) {
      cwd = candidate;
      break;
    }
    io.log(`  ✗ No existe o no es un directorio: ${candidate}`);
  }

  // Paso 2/6: Modo de sandbox bwrap
  io.log("");
  const bwrapIdx = await io.select("2/6 Permisos del sandbox bwrap (codex_exec):", [
    { id: "rw", label: "✏️  Escritura en workspace (bwrap-workspace-write)", hint: "puede editar archivos y aplicar parches en cwd" },
    { id: "ro", label: "🔒 Solo lectura (bwrap-read-only)", hint: "solo explorar y leer, sin escribir nada" },
  ]);
  if (bwrapIdx < 0) return null;
  const writable = bwrapIdx === 0;

  // Paso 3/6: Nivel de shell_exec
  io.log("");
  const shellIdx = await io.select("3/6 Acceso a shell_exec en el host:", [
    { id: "full", label: "⚡ Shell total por tiempo", hint: "bash en el host con isymem/rtk/ziggrep; caduca solo" },
    { id: "once", label: "🎯 Shell acotado por usos (allow once)", hint: "elige cuántos usos (1-10); caduca en máx 1h" },
    { id: "none", label: "🛡️  Sin shell_exec (solo sandbox bwrap)", hint: "máximo aislamiento: solo codex_exec" },
  ]);
  if (shellIdx < 0) return null;
  const shellMode: ShellAccessMode = shellIdx === 0 ? "full" : shellIdx === 1 ? "once" : "none";

  let shellUses = 0;
  if (shellMode === "once") {
    for (;;) {
      const rawUses = await io.ask(`    ¿Cuántos usos de shell_exec? [5] (1-${ONCE_MAX_USES}): `);
      const n = rawUses === "" ? 5 : Number(rawUses);
      if (Number.isInteger(n) && n >= 1 && n <= ONCE_MAX_USES) {
        shellUses = n;
        break;
      }
      io.log(`  ✗ Escribe un entero entre 1 y ${ONCE_MAX_USES}`);
    }
  }

  // Paso 4/6: Duración (horas)
  io.log("");
  const durationOptions: Array<{ id: string; label: string; hint?: string; value?: string }> = [
    { id: "1h", label: "1 hora", value: "1h" },
    { id: "2h", label: "2 horas", value: "2h" },
    { id: "4h", label: "4 horas (recomendado)", value: "4h" },
    { id: "8h", label: "8 horas", value: "8h" },
    { id: "12h", label: "12 horas", value: "12h" },
    { id: "24h", label: "24 horas (máximo)", value: "24h" },
    { id: "custom", label: "✏️  Escribir otra duración…", hint: "ej. 30m, 3, 6h" },
  ];
  const durIdx = await io.select("4/6 ¿Cuántas horas dura este sandbox?", durationOptions);
  if (durIdx < 0) return null;

  let ttlMs: number;
  if (durationOptions[durIdx]!.id === "custom") {
    for (;;) {
      const rawDur = await io.ask("    Duración (ej. 30m, 3, 6h; máx 24h) [4h]: ");
      try {
        ttlMs = parseFlexDuration(rawDur || DEFAULT_FOR);
        break;
      } catch (err) {
        io.log(`  ✗ ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } else {
    ttlMs = parseFlexDuration(durationOptions[durIdx]!.value);
  }

  // Paso 5/6: Herramientas en el prompt
  io.log("");
  const availNames = Object.entries(detected).filter(([, ok]) => ok).map(([k]) => k).join(" + ") || "ninguna extra";
  const toolChoices: MenuItem[] = [
    { id: "all", label: `🧰 Todas las detectadas (${availNames})`, hint: "flujo completo de agente local" },
    { id: "mem-rtk", label: "🧠 Memoria + salida compacta (isymem + rtk)", hint: "sin bloque de ziggrep" },
    { id: "rtk", label: "⚡ Solo salida compacta (rtk)", hint: "sin memoria compartida en el prompt" },
    { id: "none", label: "📦 Mínimo (solo sandbox)", hint: "prompt limpio sin bloque de herramientas" },
  ];
  const toolIdx = await io.select("5/6 Herramientas a incluir en el prompt:", toolChoices);
  if (toolIdx < 0) return null;
  const tools: DetectedAgentTools =
    toolIdx === 0 ? detected
      : toolIdx === 1 ? { isymem: detected.isymem, rtk: detected.rtk, ziggrep: false }
        : toolIdx === 2 ? { isymem: false, rtk: detected.rtk, ziggrep: false }
          : { isymem: false, rtk: false, ziggrep: false };

  // Paso 6/6: Tarea inicial y confirmación
  io.log("");
  const taskRaw = await io.ask("6/6 Tarea inicial para GPT (Enter = exploración automática): ");
  const task = taskRaw.trim() || undefined;

  const shellSummary = shellMode === "full"
    ? `total por ${formatTtl(ttlMs)}`
    : shellMode === "once"
      ? `acotado a ${shellUses} uso(s) (máx ${formatTtl(Math.min(ttlMs, ONCE_MAX_TTL_MS))})`
      : "apagado (solo bwrap)";
  const toolSummary = Object.entries(tools).filter(([, ok]) => ok).map(([k]) => k).join(", ") || "ninguna";

  io.log("");
  io.log("Resumen:");
  io.log(`  carpeta:    ${cwd}`);
  io.log(`  sandbox:    ${writable ? "escritura (bwrap-workspace-write)" : "solo lectura (bwrap-read-only)"}`);
  io.log(`  shell_exec: ${shellSummary}`);
  io.log(`  duración:   ${formatTtl(ttlMs)}`);
  io.log(`  tools:      ${toolSummary}`);
  if (task) io.log(`  tarea:      ${task}`);
  io.log("");

  const okRaw = await io.ask("¿Activar ahora y generar el prompt? [S/n]: ");
  if (okRaw && !/^(s|si|sí|y|yes)$/i.test(okRaw)) return null;

  return {
    cwd,
    ttlMs,
    label: DEFAULT_LABEL,
    writable,
    shellMode,
    shellUses,
    tools,
    task,
    skipUp: false,
    reconnect: false,
    promptOnly: false,
    asJson: false,
  };
}

export async function applySandboxExecConfig(cfg: SandboxExecConfig): Promise<void> {
  const quietStdout = cfg.promptOnly || cfg.asJson;
  const note = (msg: string) => {
    if (quietStdout) console.error(msg);
    else console.log(msg);
  };

  // 1. Server + túnel (solo si no se pasó --no-up; si ya están listos no reinicia el túnel).
  let serverReady = await serverUp().catch(() => false);
  let tState = tunnelState();
  if (!cfg.skipUp) {
    if (!serverReady) {
      if (quietStdout) {
        const origLog = console.log;
        console.log = (...a: unknown[]) => console.error(...a);
        try { startServer(); } finally { console.log = origLog; }
      } else {
        startServer();
      }
      for (let i = 0; i < 16; i++) {
        await new Promise((r) => setTimeout(r, 250));
        if (await serverUp().catch(() => false)) {
          serverReady = true;
          break;
        }
      }
    }
    if (cfg.reconnect || !tState.ready) {
      if (quietStdout) {
        const origLog = console.log;
        console.log = (...a: unknown[]) => console.error(...a);
        try { tunnel("connect"); } finally { console.log = origLog; }
      } else {
        tunnel("connect");
      }
      tState = tunnelState();
    }
  }

  // 2. Permiso host_shell según modo elegido (total, acotado por usos o apagado).
  let shellUntil: string | null = null;
  if (cfg.shellMode === "full") {
    const next = setPermission("host_shell", true, process.env, cfg.ttlMs);
    shellUntil = next.host_shell_until ?? null;
    appendAudit({
      cap: "host_shell",
      action: "sandbox exec",
      decision: "operator",
      source: "cli",
      ttl: `${Math.round(cfg.ttlMs / 60_000)}m`,
      cwd: cfg.cwd,
      label: cfg.label,
    });
  } else if (cfg.shellMode === "once") {
    // Asegurar que el permiso abierto no quede encendido si pidió explícitamente modo acotado.
    setPermission("host_shell", false, process.env);
    const onceTtl = Math.min(cfg.ttlMs, ONCE_MAX_TTL_MS);
    const g = grantOnce("host_shell", process.env, { ttlMs: onceTtl, uses: cfg.shellUses });
    shellUntil = g.until;
    appendAudit({
      cap: "host_shell",
      action: "sandbox exec (once)",
      decision: "operator",
      source: "cli",
      uses: cfg.shellUses,
      ttl: `${Math.round(onceTtl / 60_000)}m`,
      cwd: cfg.cwd,
      label: cfg.label,
    });
  }

  // 3. Sesión sandbox bwrap (codex_exec / codex_apply_patch).
  const ttlHours = cfg.ttlMs / 3_600_000;
  const session = mintSession(cfg.cwd, { label: cfg.label, writable: cfg.writable, ttlHours });
  const prompt = buildSandboxAgentPrompt({
    cwd: session.cwd,
    token: session.token,
    writable: session.writable,
    shellEnabled: cfg.shellMode !== "none",
    shellMode: cfg.shellMode,
    shellUses: cfg.shellUses,
    tools: cfg.tools,
    task: cfg.task,
  });

  const cleanup = {
    stop: `isymcp sandbox stop ${session.fp}`,
    log: "isymcp allow log",
    down: "isymcp down",
  };

  if (cfg.promptOnly) {
    process.stdout.write(`${prompt}\n`);
    return;
  }

  if (cfg.asJson) {
    console.log(JSON.stringify({
      ok: true,
      connector: CONNECTOR_NAME,
      sandbox: sandboxAvailable() ? sandboxLabel({ writable: session.writable }) : `unavailable (${sandboxUnavailableReason()})`,
      server_up: serverReady,
      tunnel: tState,
      session: {
        fp: session.fp,
        label: session.label,
        cwd: session.cwd,
        writable: session.writable,
        expires_at: session.expiresAt,
        token: session.token,
      },
      shell: {
        enabled: cfg.shellMode !== "none",
        mode: cfg.shellMode,
        uses: cfg.shellMode === "once" ? cfg.shellUses : null,
        expires_at: shellUntil,
      },
      tools: cfg.tools,
      prompt,
      cleanup,
    }, null, 2));
    return;
  }

  const ttlLabel = formatTtl(cfg.ttlMs);
  const sandboxMode = sandboxAvailable() ? sandboxLabel({ writable: session.writable }) : `no disponible (${sandboxUnavailableReason()})`;
  const toolList = Object.entries(cfg.tools).filter(([, ok]) => ok).map(([k]) => k).join(", ") || "ninguna extra";
  const shellLine = cfg.shellMode === "full"
    ? `ENCENDIDO (total) hasta ${shellUntil ? new Date(shellUntil).toLocaleTimeString() : ttlLabel}`
    : cfg.shellMode === "once"
      ? `ACOTADO a ${cfg.shellUses} uso(s) (hasta ${shellUntil ? new Date(shellUntil).toLocaleTimeString() : "1h"})`
      : "apagado (solo sandbox bwrap)";

  note("");
  note(`✓ Sandbox listo para ${CONNECTOR_NAME} (TTL ${ttlLabel})`);
  note(`  túnel:      ${cfg.skipUp ? "omitido (--no-up)" : tState.ready ? `ready (${tState.state})` : `no listo (${tState.state})`}`);
  note(`  server:     ${serverReady ? "UP" : "DOWN"}`);
  note(`  sandbox:    ${sandboxMode} · cwd=${session.cwd}`);
  note(`  sesión:     ${session.label} [fp=${session.fp}] · caduca ${session.expiresAt}`);
  note(`  shell_exec: ${shellLine}`);
  note(`  tools:      ${toolList}`);
  note("");
  note(`--- COPIA Y PEGA EN CHATGPT (elige el app ${CONNECTOR_NAME} en el composer) ---`);
  console.log(prompt);
  note("--- FIN DEL PROMPT ---");
  note("");
  note(`Para apagar:  ${cleanup.stop}   (o con --down para bajar túnel y server)`);
  note(`Bitácora:     ${cleanup.log}`);
}

const DIRECT_FLAGS = new Set([
  "--cwd", "--for", "--label", "--ro", "--read-only", "--no-shell", "--shell-uses",
  "--no-up", "--reconnect", "--task", "--prompt-only", "--json", "--yes", "-y",
]);

function hasDirectFlags(args: string[]): boolean {
  return args.some((a) => DIRECT_FLAGS.has(a) || a.startsWith("--cwd=") || a.startsWith("--for=") || a.startsWith("--label=") || a.startsWith("--shell-uses=") || a.startsWith("--task="));
}

export async function sandboxExec(rest: string[], opts: { forceWizard?: boolean } = {}): Promise<void> {
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(SANDBOX_HELP);
    return;
  }

  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const wantWizard = opts.forceWizard || rest.includes("--wizard") || rest.includes("-i") || (interactive && !hasDirectFlags(rest));

  if (wantWizard) {
    if (!interactive) {
      console.error("✗ el modo wizard requiere una terminal interactiva (usa flags como --for 4h --yes sin TTY)");
      process.exitCode = 2;
      return;
    }
    const cfg = await runSandboxWizard();
    if (!cfg) {
      console.log("cancelado; no se tocó nada");
      return;
    }
    await applySandboxExecConfig(cfg);
    return;
  }

  const cwdArg = flag("--cwd", rest) ?? process.cwd();
  const cwd = resolve(cwdArg);
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    console.error(`✗ --cwd no existe o no es un directorio: ${cwd}`);
    process.exitCode = 2;
    return;
  }

  let ttlMs: number;
  try {
    ttlMs = parseFlexDuration(flag("--for", rest));
  } catch (err) {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
    return;
  }

  const shellUsesRaw = flag("--shell-uses", rest);
  let shellUses = 0;
  let shellMode: ShellAccessMode = rest.includes("--no-shell") ? "none" : "full";
  if (shellUsesRaw !== undefined) {
    const n = Number(shellUsesRaw);
    if (!Number.isInteger(n) || n < 1 || n > ONCE_MAX_USES) {
      console.error(`✗ --shell-uses debe ser un entero entre 1 y ${ONCE_MAX_USES}`);
      process.exitCode = 2;
      return;
    }
    shellMode = "once";
    shellUses = n;
  }

  await applySandboxExecConfig({
    cwd,
    ttlMs,
    label: (flag("--label", rest) ?? DEFAULT_LABEL).trim() || DEFAULT_LABEL,
    writable: !(rest.includes("--ro") || rest.includes("--read-only")),
    shellMode,
    shellUses,
    tools: detectAgentTools(),
    task: flag("--task", rest),
    skipUp: rest.includes("--no-up"),
    reconnect: rest.includes("--reconnect"),
    promptOnly: rest.includes("--prompt-only"),
    asJson: rest.includes("--json"),
  });
}

export async function sandboxStop(rest: string[]): Promise<void> {
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(SANDBOX_HELP);
    return;
  }

  const down = rest.includes("--down");
  const targetFp = rest.find((a) => !a.startsWith("-"));

  setPermission("host_shell", false, process.env);
  appendAudit({ cap: "host_shell", action: "sandbox stop", decision: "operator", source: "cli" });
  console.log("  ○ shell_exec apagado");

  let revoked = 0;
  if (targetFp) {
    revoked = revokeSession(targetFp);
    console.log(`  ✓ sesiones revocadas (${targetFp}): ${revoked}`);
  } else {
    const activeSandbox = listUserSessions().filter((s) => !isExpired(s) && s.label.startsWith(DEFAULT_LABEL));
    for (const s of activeSandbox) {
      revoked += revokeSession(s.fp);
    }
    console.log(revoked > 0
      ? `  ✓ sesiones '${DEFAULT_LABEL}' revocadas: ${revoked}`
      : `  · no había sesiones '${DEFAULT_LABEL}' activas`);
  }

  if (down) {
    tunnel("stop");
    stopServer();
  }
}

export async function sandboxStatus(rest: string[]): Promise<void> {
  const asJson = rest.includes("--json");
  const backend = sandboxAvailable() ? sandboxLabel({ writable: true }) : "unavailable";
  const shellSrc = permissionSource("host_shell");
  const shellFg = fileGrant("host_shell");
  const onceUses = pendingOnceGrants("host_shell").reduce((n, g) => n + g.uses, 0);
  const tState = tunnelState();
  const up = await serverUp().catch(() => false);
  const tools = detectAgentTools();
  const sessions = listUserSessions()
    .filter((s) => !isExpired(s))
    .map((s) => ({ fp: s.fp, label: s.label, cwd: s.cwd, writable: s.writable, expires_at: s.expiresAt ?? null }));

  if (asJson) {
    console.log(JSON.stringify({
      backend,
      server_up: up,
      tunnel: tState,
      shell: { on: shellSrc !== null, source: shellSrc, until: shellFg.until, once_uses: onceUses },
      tools,
      active_sessions: sessions,
    }, null, 2));
    return;
  }

  const shellDesc = shellSrc
    ? `ENCENDIDO (${shellSrc}${shellFg.until ? `, hasta ${new Date(shellFg.until).toLocaleTimeString()}` : ""})`
    : onceUses > 0
      ? `ACOTADO (${onceUses} uso(s) pendiente(s))`
      : "apagado";

  console.log(`isymcp sandbox`);
  console.log(`  backend     ${backend}`);
  console.log(`  server      ${up ? "up" : "down"}`);
  console.log(`  túnel       ready=${tState.ready} state=${tState.state}`);
  console.log(`  shell_exec  ${shellDesc}`);
  console.log(`  tools       ${Object.entries(tools).map(([k, v]) => `${k}=${v ? "ok" : "no"}`).join(" · ")}`);
  console.log(`  sesiones    ${sessions.length} activa(s)`);
  for (const s of sessions) {
    console.log(`    · ${s.fp}  ${s.writable ? "rw" : "ro"}  ${s.label}  ${s.cwd}`);
  }
}

export const sandboxModule: CliModule = {
  names: ["sandbox", "shell"],
  async run(sub, rest) {
    if (sub === "help" || sub === "--help" || sub === "-h") {
      console.log(SANDBOX_HELP);
      return;
    }
    if (!sub) {
      if (process.stdin.isTTY && process.stdout.isTTY) {
        const pick = await select("⚡ ISyMCP Sandbox / Shell:", [
          { id: "wizard", label: "⚡ Configurar sandbox + shell_exec (wizard)", hint: "paso a paso -> genera prompt con token" },
          { id: "status", label: "○ Ver estado actual", hint: "túnel, shell_exec y sesiones vivas" },
          { id: "stop", label: "■ Apagar sandbox y shell_exec", hint: "revoca sesiones gpt-sandbox" },
        ]);
        if (pick === 0) await sandboxExec([], { forceWizard: true });
        else if (pick === 1) await sandboxStatus([]);
        else if (pick === 2) await sandboxStop([]);
        else console.log("cancelado");
        return;
      }
      console.log(SANDBOX_HELP);
      return;
    }
    if (sub === "wizard" || sub === "setup") {
      await sandboxExec(rest, { forceWizard: true });
      return;
    }
    if (sub === "exec" || sub === "up" || sub === "start") {
      await sandboxExec(rest);
      return;
    }
    if (sub === "stop" || sub === "off" || sub === "down") {
      await sandboxStop(rest);
      return;
    }
    if (sub === "status") {
      await sandboxStatus(rest);
      return;
    }
    console.error(`✗ subcomando desconocido para sandbox/shell: '${sub}'\n`);
    console.error(SANDBOX_HELP);
    process.exitCode = 2;
  },
};
