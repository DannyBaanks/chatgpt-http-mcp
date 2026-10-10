// exec-registry.ts — procesos en segundo plano con stdin vivo (write_stdin).
//
// codex_exec con background=true deja el proceso vivo y devuelve un exec_id;
// codex_write_stdin escribe a su stdin y devuelve la salida NUEVA desde la
// ultima lectura. El registro vive en el proceso del MCP (el tunel conecta
// una sola vez, asi que los exec_id sobreviven entre tool calls del turno).
//
// Anti-huerfanos, por capas:
//   1. TTL de inactividad (CODEX_WEB_HTTP_BG_TTL_MS, 15 min por defecto):
//      el sweeper mata y borra lo vencido.
//   2. codex_turn_complete mata todo lo vivo de esa sesion (killSessionExecs).
//   3. bwrap --die-with-parent: si el MCP muere, la burbuja muere con el.
//   4. exit handler: KILL de todo lo vivo si el MCP termina con procesos.
//
// Aislamiento: cada LiveExec guarda el fingerprint de la sesion que lo creo;
// write_stdin rechaza exec_id de otra sesion. Buffers acotados (512 KiB por
// stream, se recorta lo viejo y la marca de lectura se ajusta).
import { randomBytes } from "node:crypto";

/** Interfaz estructural del proceso (evita acoplarnos a los tipos de Bun). */
export interface BgProc {
  stdin: { write(data: string): unknown; flush(): unknown; end(): unknown };
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  kill(signal?: number): void;
  exited: Promise<number>;
}

export interface LiveExec {
  id: string;
  sessionFp: string;
  command: string[];
  cwd: string;
  proc: BgProc;
  startedAt: number;
  lastTouched: number;
  expiresAt: number;
  out: string;
  err: string;
  /** Indice de lo ya devuelto al llamador (delta = out.slice(outMark)). */
  outMark: number;
  errMark: number;
  exited: boolean;
  exitCode: number | null;
  stdinClosed: boolean;
}

export interface DrainOut {
  stdout: string;
  stderr: string;
  alive: boolean;
  exitCode: number | null;
}

const MAX_LIVE = 16;
const MAX_BUF = 512 * 1024;
const SWEEP_MS = 30_000;

const live = new Map<string, LiveExec>();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function bgTtlMs(): number {
  return Number(process.env.CODEX_WEB_HTTP_BG_TTL_MS ?? "") || 900_000;
}

function pushBuf(rec: LiveExec, key: "out" | "err", chunk: string): void {
  rec[key] += chunk;
  if (rec[key].length > MAX_BUF) {
    const drop = rec[key].length - MAX_BUF;
    rec[key] = rec[key].slice(drop);
    if (key === "out") rec.outMark = Math.max(0, rec.outMark - drop);
    else rec.errMark = Math.max(0, rec.errMark - drop);
  }
}

function attachStream(stream: ReadableStream<Uint8Array>, rec: LiveExec, key: "out" | "err"): void {
  (async () => {
    const reader = stream.getReader();
    const dec = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          const rest = dec.decode();
          if (rest) pushBuf(rec, key, rest);
          return;
        }
        pushBuf(rec, key, dec.decode(value, { stream: true }));
      }
    } catch {
      /* el stream muere con el proceso; el buffer queda como esta */
    }
  })();
}

export function registerLiveExec(input: { sessionFp: string; command: string[]; cwd: string; proc: BgProc }): LiveExec {
  if (live.size >= MAX_LIVE) {
    throw new Error(`limite de procesos en segundo plano alcanzado (${MAX_LIVE}); cierra los vivos con codex_turn_complete`);
  }
  ensureSweeper();
  const now = Date.now();
  const rec: LiveExec = {
    id: `exec_${randomBytes(6).toString("hex")}`,
    sessionFp: input.sessionFp,
    command: input.command,
    cwd: input.cwd,
    proc: input.proc,
    startedAt: now,
    lastTouched: now,
    expiresAt: now + bgTtlMs(),
    out: "",
    err: "",
    outMark: 0,
    errMark: 0,
    exited: false,
    exitCode: null,
    stdinClosed: false,
  };
  live.set(rec.id, rec);
  attachStream(input.proc.stdout, rec, "out");
  attachStream(input.proc.stderr, rec, "err");
  input.proc.exited.then(
    (code) => {
      rec.exited = true;
      rec.exitCode = code;
    },
    () => {
      rec.exited = true;
      rec.exitCode = -1;
    },
  );
  return rec;
}

export function findLive(id: string): LiveExec | null {
  const rec = live.get(id);
  if (!rec) return null;
  if (rec.expiresAt <= Date.now()) {
    // Vencido por inactividad: muere ahora y desaparece.
    killExec(rec);
    live.delete(rec.id);
    return null;
  }
  return rec;
}

export function killExec(rec: LiveExec): void {
  try {
    rec.proc.kill();
  } catch {
    /* ya muerto */
  }
  const hard = setTimeout(() => {
    try {
      rec.proc.kill(9);
    } catch {
      /* ya muerto */
    }
  }, 2_000);
  hard.unref?.();
}

/** Mata y borra todo lo vivo de una sesion (codex_turn_complete). */
export function killSessionExecs(sessionFp: string): number {
  let killed = 0;
  for (const rec of [...live.values()]) {
    if (rec.sessionFp === sessionFp) {
      killExec(rec);
      live.delete(rec.id);
      killed++;
    }
  }
  return killed;
}

function sweep(): void {
  const now = Date.now();
  for (const rec of [...live.values()]) {
    if (rec.exited) {
      live.delete(rec.id);
      continue;
    }
    if (rec.expiresAt <= now) {
      killExec(rec);
      live.delete(rec.id);
    }
  }
}

let sweeper: { unref?: () => void } | null = null;
function ensureSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(sweep, SWEEP_MS) as unknown as { unref?: () => void };
  sweeper.unref?.();
}

process.on("exit", () => {
  for (const rec of [...live.values()]) {
    try {
      rec.proc.kill(9);
    } catch {
      /* ya muerto */
    }
  }
});

/**
 * Espera salida nueva hasta `waitMs`: corta con (a) proceso terminado,
 * (b) salida estable 250 ms tras crecer, o (c) deadline. Devuelve solo el
 * DELTA desde la ultima lectura y avanza las marcas.
 */
export async function drain(rec: LiveExec, waitMs: number): Promise<DrainOut> {
  if (waitMs > 0) {
    const deadline = Date.now() + waitMs;
    let quietMs = 0;
    let sawNew = false;
    let lastOut = rec.out.length;
    let lastErr = rec.err.length;
    while (Date.now() < deadline) {
      await sleep(25);
      const grew = rec.out.length !== lastOut || rec.err.length !== lastErr;
      lastOut = rec.out.length;
      lastErr = rec.err.length;
      if (grew) {
        sawNew = true;
        quietMs = 0;
      } else {
        quietMs += 25;
      }
      if (rec.exited) {
        // da un instante a los readers para volcar lo ultimo del pipe
        await sleep(60);
        break;
      }
      if (sawNew && quietMs >= 250) break;
    }
  }
  const stdout = rec.out.slice(rec.outMark);
  rec.outMark = rec.out.length;
  const stderr = rec.err.slice(rec.errMark);
  rec.errMark = rec.err.length;
  return { stdout, stderr, alive: !rec.exited, exitCode: rec.exited ? rec.exitCode : null };
}

export interface WriteStdinOpts {
  close?: boolean;
  signal?: "TERM" | "KILL";
  waitMs: number;
}

/** Escribe al stdin (o manda señal), drena y devuelve el delta de salida. */
export async function writeStdin(rec: LiveExec, data: string, opts: WriteStdinOpts): Promise<DrainOut & { wrote: number }> {
  rec.lastTouched = Date.now();
  rec.expiresAt = rec.lastTouched + bgTtlMs();
  let wrote = 0;
  if (opts.signal === "KILL" || opts.signal === "TERM") {
    try {
      rec.proc.kill(opts.signal === "KILL" ? 9 : undefined);
    } catch {
      /* ya muerto */
    }
  } else {
    if (data.length > 0) {
      const r = rec.proc.stdin.write(data);
      wrote = typeof r === "number" ? r : Buffer.byteLength(data);
      try {
        rec.proc.stdin.flush();
      } catch {
        /* el stdin se esta cerrando */
      }
    }
    if (opts.close) {
      try {
        rec.proc.stdin.end();
      } catch {
        /* ya cerrado */
      }
      rec.stdinClosed = true;
    }
  }
  const drained = await drain(rec, opts.waitMs);
  return { wrote, ...drained };
}
