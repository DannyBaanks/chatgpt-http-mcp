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
import { bridgeHome } from "./codex-sessions";
import { createChat, listChats } from "./chats";

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
}

export function canaryDir(): string {
  return join(bridgeHome(), "canary");
}

export function readLatestCanary(): CanaryResult | null {
  try {
    return JSON.parse(readFileSync(join(canaryDir(), "latest.json"), "utf8")) as CanaryResult;
  } catch {
    return null;
  }
}

function saveResult(result: CanaryResult): void {
  mkdirSync(canaryDir(), { recursive: true, mode: 0o700 });
  const body = `${JSON.stringify(result, null, 2)}\n`;
  writeFileSync(join(canaryDir(), "latest.json"), body, { mode: 0o600 });
  writeFileSync(join(canaryDir(), `canary-${result.ts.slice(0, 10)}.json`), body, { mode: 0o600 });
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

  const up = async (url: string) => fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
  if (!opts.turn && !(await up(base))) {
    if (opts.spawnBridge === false) {
      const result: CanaryResult = { ts, ok: false, bridge: "unavailable", checks: [], error: `bridge apagado en ${base}` };
      saveResult(result);
      return result;
    }
    // Bridge temporal en un puerto que el sistema confirma libre (al azar en un
    // rango podia chocar con otro servicio local, p. ej. un gateway en 8787).
    const tempPort = String(freePort());
    temp = Bun.spawn(["bun", "run", join(import.meta.dir, "cli.ts")], {
      env: { ...process.env, CODEX_WEB_HTTP_PORT: tempPort, CODEX_WEB_HTTP_CONNECTOR: "" },
      stdin: "ignore", stdout: "ignore", stderr: "ignore",
    });
    base = `http://127.0.0.1:${tempPort}`;
    bridge = "temporary";
    for (let i = 0; i < 40 && !(await up(base)); i++) await Bun.sleep(500);
  }

  const turn: Turn = opts.turn ?? (async (chatId, message) => {
    const r = await fetch(`${base}/isymcp/chat/turn`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message }), signal: AbortSignal.timeout(240_000),
    });
    const data = (await r.json().catch(() => null)) as { ok?: boolean; reply?: { text?: string; meta?: { kind?: string } }; error?: { message?: string } } | null;
    return { ok: data?.ok === true, text: data?.reply?.text ?? data?.error?.message ?? `HTTP ${r.status}`, kind: data?.reply?.meta?.kind };
  });

  const checks: CanaryCheck[] = [];
  let error: string | undefined;
  try {
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
    if (temp) { temp.kill(); await temp.exited; }
  }
  const result: CanaryResult = { ts, ok: !error && checks.length === 3 && checks.every((c) => c.ok), bridge, checks, ...(error ? { error } : {}) };
  saveResult(result);
  return result;
}

/** Aviso de escritorio si hay pantalla y notify-send (best-effort). */
export async function notifyFailure(result: CanaryResult): Promise<void> {
  if (result.ok || (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) || !Bun.which("notify-send")) return;
  const failed = result.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join("\n") || result.error || "fallo";
  const p = Bun.spawn(["notify-send", "-u", "critical", "ISyMCP: el canario fallo", failed], { stdout: "ignore", stderr: "ignore" });
  await p.exited;
}
