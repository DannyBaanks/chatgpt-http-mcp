// canary.ts — canario diario: ¿sigue funcionando la captura contra el
// chatgpt.com de HOY? Avisa el dia que ChatGPT cambie su pagina, no cuando ya
// lo estes usando.
//
// Criterio "Never Guess": no basta con que "conteste algo".
//   1. eco-a      : responde EXACTAMENTE un nonce A          (captura viva)
//   2. eco-b      : responde EXACTAMENTE un nonce B y NO trae A
//                   (la respuesta es de ESTE turno: sin contaminacion)
//   3. markdown   : lista + bloque de codigo reconstruidos   (DOM -> Markdown)
//
// Va por el camino real (bridge /isymcp/chat/turn -> Chrome -> chatgpt.com),
// siempre en el MISMO chat "[canary] ISyMCP" para no llenar la barra lateral.
// Si el bridge no esta encendido levanta uno temporal y lo apaga al terminar.
// Resultado: ~/.codex-web-http/canary/latest.json (+ historial por dia).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { desktopNotice, type Notice } from "./notice";
import { bridgeHome } from "./codex-sessions";
import { createChat, listChats } from "./chats";
import { bridgeAuthHeaders } from "./local-guard";

export const CANARY_TITLE = "[canary] ISyMCP";

export interface CanaryCheck {
  name: "eco-a" | "eco-b" | "markdown";
  ok: boolean;
  ms: number;
  detail: string;
}

export interface CanaryResult {
  ts: string;
  ok: boolean;
  bridge: "existing" | "temporary" | "unavailable";
  checks: CanaryCheck[];
  error?: string;
  notice?: Notice;
}

export function canaryDir(): string {
  return join(bridgeHome(), "canary");
}

export function readLatestCanary(): CanaryResult | null {
  try {
    const result = JSON.parse(readFileSync(join(canaryDir(), "latest.json"), "utf8")) as CanaryResult;
    if (!result.ok && !result.notice) result.notice = failureNotice(result, join(canaryDir(), "latest.json"));
    return result;
  } catch {
    return null;
  }
}

function saveResult(result: CanaryResult): void {
  mkdirSync(canaryDir(), { recursive: true, mode: 0o700 });
  // Every failure points to its own snapshot; later runs cannot replace it.
  if (!result.ok) {
    const evidence = join(canaryDir(), `failure-${result.ts.replace(/[:.]/g, "-")}-${randomUUID()}.json`);
    result.notice = failureNotice(result, evidence);
    writeFileSync(evidence, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  }
  const body = `${JSON.stringify(result, null, 2)}\n`;
  writeFileSync(join(canaryDir(), "latest.json"), body, { mode: 0o600 });
  writeFileSync(join(canaryDir(), `canary-${result.ts.slice(0, 10)}.json`), body, { mode: 0o600 });
}

/** Classify only what the recorded failure demonstrates. Raw detail stays in evidence. */
function failureNotice(result: CanaryResult, evidence: string): Notice {
  const failed = result.checks.find((check) => !check.ok);
  let component = "canary";
  let summary = "El canario no pudo completar la prueba.";
  let severity: Notice["severity"] = "error";
  if (result.error?.startsWith("bridge temporal")) {
    component = "canary.bridge.startup";
    summary = "El bridge temporal no arranco.";
    if (/CODEX_WEB_HTTP_\w+ invalido/.test(result.error)) {
      summary = "El bridge temporal no arranco: configuracion invalida.";
      severity = "action_required";
    }
  } else if (result.bridge === "unavailable" || /Unable to connect|fetch failed|ECONNREFUSED/i.test(result.error ?? "")) {
    component = "canary.bridge.connection";
    summary = "No se pudo conectar con el bridge local.";
  } else if (failed) {
    component = `canary.capture.${failed.name}`;
    summary = failed.detail.startsWith("CONTAMINADA")
      ? "La respuesta contiene texto del turno anterior."
      : failed.name === "markdown" ? "La respuesta no conserva la lista o el bloque de codigo."
        : `La respuesta no supero la comprobacion ${failed.name}.`;
  }
  return { kind: "NOTICE", severity, source: "isymcp", component, event: "canary_failed", summary,
    evidence_ref: evidence, action: "isymcp canary status" };
}

/** El chat del canario (uno solo, reutilizado). */
export function canaryChatId(): string {
  const existing = listChats().find((c) => c.title === CANARY_TITLE);
  return existing ? existing.id : createChat(CANARY_TITLE).id;
}

const strip = (s: string) => s.trim().replace(/^`+|`+$/g, "").replace(/^\*\*|\*\*$/g, "").trim();

/** Evalua las respuestas (puro: lo usan los tests). */
export function judge(name: CanaryCheck["name"], reply: string, expect: { exact?: string; absent?: string }): { ok: boolean; detail: string } {
  if (name === "markdown") {
    const list = /^(\s*[-*]\s+|\s*\d+[.)]\s+)\S/m.test(reply);
    const fence = /```[\s\S]*canario[\s\S]*```/.test(reply);
    return { ok: list && fence, detail: list && fence ? "lista + bloque de codigo" : `${list ? "" : "sin lista "}${fence ? "" : "sin bloque de codigo"}`.trim() };
  }
  const got = strip(reply);
  if (expect.absent && reply.includes(expect.absent)) return { ok: false, detail: `CONTAMINADA: trae el nonce del turno anterior (${expect.absent})` };
  if (expect.exact && got !== expect.exact) return { ok: false, detail: `esperado ${expect.exact}, recibido ${JSON.stringify(got.slice(0, 80))}` };
  return { ok: true, detail: "exacta" };
}

type Turn = (chatId: string, message: string) => Promise<{ ok: boolean; text: string; kind?: string }>;

/** Puerto libre en 127.0.0.1 segun el propio sistema. */
export function freePort(): number {
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = probe.port;
  probe.stop(true);
  return port;
}

export async function runCanary(opts: { port?: string; turn?: Turn; spawnBridge?: boolean } = {}): Promise<CanaryResult> {
  const port = opts.port ?? (process.env.CODEX_WEB_HTTP_PORT?.trim() || "8791");
  const ts = new Date().toISOString();
  let base = `http://127.0.0.1:${port}`;
  let bridge: "existing" | "temporary" | "unavailable" = "existing";
  let temp: ReturnType<typeof Bun.spawn> | null = null;
  let tempStderr: Promise<string> | null = null;

  const turn: Turn = opts.turn ?? (async (chatId, message) => {
    const r = await fetch(`${base}/isymcp/chat/turn`, {
      method: "POST", headers: bridgeAuthHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ chat_id: chatId, message }), signal: AbortSignal.timeout(240_000),
    });
    const data = (await r.json().catch(() => null)) as { ok?: boolean; reply?: { text?: string; meta?: { kind?: string } }; error?: { message?: string } } | null;
    return { ok: data?.ok === true, text: data?.reply?.text ?? data?.error?.message ?? `HTTP ${r.status}`, kind: data?.reply?.meta?.kind };
  });

  const checks: CanaryCheck[] = [];
  let error: string | undefined;
  try {
    const up = async (url: string) => fetch(`${url}/health`, { headers: bridgeAuthHeaders(), signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
    if (!opts.turn && !(await up(base))) {
      if (opts.spawnBridge === false) {
        const result: CanaryResult = { ts, ok: false, bridge: "unavailable", checks: [], error: `bridge apagado en ${base}` };
        saveResult(result);
        return result;
      }
      // Bridge temporal en un puerto que el sistema confirma libre (al azar en un
      // rango podia chocar con otro servicio local, p. ej. un gateway en 8787).
      const tempPort = String(freePort());
      temp = Bun.spawn([process.execPath, "run", join(import.meta.dir, "cli.ts")], {
        env: { ...process.env, CODEX_WEB_HTTP_PORT: tempPort, CODEX_WEB_HTTP_CONNECTOR: "" },
        stdin: "ignore", stdout: "ignore", stderr: "pipe",
      });
      // Drain stderr while the child runs so a full pipe cannot block startup.
      tempStderr = new Response(temp.stderr).text();
      base = `http://127.0.0.1:${tempPort}`;
      bridge = "temporary";
      let ready = false;
      for (let i = 0; i < 40; i++) {
        if (temp.exitCode !== null) {
          const detail = (await tempStderr).trim().slice(-1000);
          throw new Error(`bridge temporal no arranco (exit ${temp.exitCode}): ${detail}`);
        }
        if (await up(base)) { ready = true; break; }
        await Bun.sleep(500);
      }
      if (!ready) throw new Error("bridge temporal no respondio a /health a tiempo");
    }

    const chatId = canaryChatId();
    const nonce = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
    const A = `CANARY-A-${nonce()}`;
    const B = `CANARY-B-${nonce()}`;
    const plan: Array<{ name: CanaryCheck["name"]; msg: string; expect: { exact?: string; absent?: string } }> = [
      { name: "eco-a", msg: `Canario de ISyMCP. Responde EXACTAMENTE este texto, sin nada mas: ${A}`, expect: { exact: A } },
      { name: "eco-b", msg: `Ahora responde EXACTAMENTE este otro texto, sin nada mas: ${B}`, expect: { exact: B, absent: A } },
      { name: "markdown", msg: "Responde solo con una lista de dos puntos (uno, dos) y despues un bloque de codigo bash que contenga: echo canario", expect: {} },
    ];
    for (const step of plan) {
      const started = Date.now();
      const r = await turn(chatId, step.msg);
      const verdict = r.ok ? judge(step.name, r.text, step.expect) : { ok: false, detail: `turno fallido (${r.kind ?? "error"}): ${r.text.slice(0, 160)}` };
      checks.push({ name: step.name, ok: verdict.ok, ms: Date.now() - started, detail: verdict.detail });
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  } finally {
    if (temp) {
      if (temp.exitCode === null) temp.kill();
      await temp.exited;
      await tempStderr;
    }
  }
  const result: CanaryResult = { ts, ok: !error && checks.length === 3 && checks.every((c) => c.ok), bridge, checks, ...(error ? { error } : {}) };
  saveResult(result);
  return result;
}

/** Aviso de escritorio si hay pantalla y notify-send (best-effort). */
export async function notifyFailure(result: CanaryResult): Promise<void> {
  if (result.ok || (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) || !Bun.which("notify-send")) return;
  const notice = result.notice ?? failureNotice(result, join(canaryDir(), "latest.json"));
  const { title, body } = desktopNotice(notice);
  const p = Bun.spawn(["notify-send", "-u", "critical", title, body], { stdout: "ignore", stderr: "ignore" });
  await p.exited;
}
