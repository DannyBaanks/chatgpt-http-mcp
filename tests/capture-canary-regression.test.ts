import { expect, test } from "bun:test";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { renderMain } from "../src/panel";
import { extractResponse, isNewAssistantTurn } from "../src/web-turn";

// Execute the production DOM reader with only the browser boundary replaced.
const source = readFileSync(join(import.meta.dir, "../src/web-turn.ts"), "utf8");
const readers = source.slice(source.indexOf("const ASSISTANT_PRIMARY_SELECTOR"), source.indexOf("/** Markdown de la ultima respuesta"));
const js = new Bun.Transpiler({ loader: "ts" }).transformSync(readers.replace(/export /g, ""));
const reader = new Function("extractResponse", `${js}; return async (page) => typeof readLastAssistantSnapshot === 'function' ? readLastAssistantSnapshot(page) : {id: await lastAssistantIdentity(page), text: await readLastAssistant(page)};`)(extractResponse);

function turn(id: string, text: string, markdown: boolean) {
  return { innerText: text, getAttribute: (name: string) => name === "data-turn-id" ? id : null,
    querySelectorAll: () => markdown ? [{ innerText: text }] : [] };
}
function pageFor(turns: ReturnType<typeof turn>[]) {
  return { evaluate: async (fn: any, args: any) => {
    const previous = (globalThis as any).document;
    (globalThis as any).document = { querySelectorAll: () => turns };
    try { return fn(args); } finally { (globalThis as any).document = previous; }
  } };
}

test("new empty assistant container cannot borrow previous markdown", async () => {
  const snapshot = await reader(pageFor([turn("old", "OLD", true), turn("new", "", false)]));
  expect(snapshot).toEqual({ id: "new", text: "" });
  expect(isNewAssistantTurn("old", "OLD", snapshot.id, snapshot.text)).toBe(false);
});
test("identical OK replies from distinct containers are accepted", async () => {
  const snapshot = await reader(pageFor([turn("old", "OK", true), turn("new", "OK", true)]));
  expect(snapshot).toEqual({ id: "new", text: "OK" });
  expect(isNewAssistantTurn("old", "OK", snapshot.id, snapshot.text)).toBe(true);
});
test("an empty marked assistant ignores its surrounding personality survey", async () => {
  const empty = turn("new", "ChatGPT dijo:\n¿Te gusta esta personalidad?", false);
  empty.querySelectorAll = (selector?: string) => selector?.includes("assistant-message") ? [{ innerText: "" }] : [];
  expect(await reader(pageFor([empty]))).toEqual({ id: "new", text: "" });
});
test("legacy marker containers never return a survey as an assistant answer", async () => {
  const survey = "¿Te gusta esta personalidad?";
  expect(extractResponse(`ChatGPT dijo:\n${survey}`)).toBe("");
  expect(await reader(pageFor([turn("new", `ChatGPT dijo:\n${survey}`, false)]))).toEqual({ id: "new", text: "" });
  expect(await reader(pageFor([turn("new", `ChatGPT dijo:\nOK\n${survey}`, false)]))).toEqual({ id: "new", text: "OK" });
  expect(extractResponse("ChatGPT said:\nDo you like this personality?")).toBe("");
});
test("missing identity is not evidence that the old answer is new", () => {
  expect(isNewAssistantTurn("old", "OLD", "", "OLD")).toBe(false);
});

test("missing previous identity does not make unchanged previous text new", () => {
  expect(isNewAssistantTurn("", "OLD", "", "OLD")).toBe(false);
});

// Run the actual capture loop on a virtual clock; no real browser or long wait.
const loop = source.slice(source.indexOf('  let text = "";', source.indexOf("const graceUntil")), source.indexOf("  if (!text.trim()) await dumpCaptureFailure"));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const capture = new AsyncFunction("page", "Date", "deadline", "settleMs", "beforeId", "beforeText", "readLastAssistant", "lastAssistantIdentity", "readLastAssistantSnapshot", "isNewAssistantTurn", "stopButton", `${loop}; return text;`);
async function captureFrames(frames: string[], deadline: number) {
  let now = 0;
  let index = 0;
  const snapshot = async () => ({ id: "new", text: frames[Math.min(index++, frames.length - 1)] });
  return capture({ waitForTimeout: async (ms: number) => { now += ms; } }, { now: () => now }, deadline, 500, "old", "OLD",
    async () => (await snapshot()).text, async () => "new", snapshot, isNewAssistantTurn, { isVisible: async () => false });
}
test("deadline rejects a changing partial response without stable proof", async () => {
  expect(await captureFrames(["N", "NE", "NEW"], 1500)).toBe("");
});
test("completed stable new answer is returned", async () => {
  expect(await captureFrames(["NEW"], 5000)).toBe("NEW");
});

// "systemd PATH" es un PATH despojado. El análogo Windows es SOLO System32: ni el
// directorio de bun (la afirmacion es que no se le busque por PATH) ni los directorios
// de usuario. Aqui se midio que System32 basta: whoami.exe, que la ruta privada si
// necesita resolver, vive ahi.
const minimalPathValue = process.platform === "win32"
  ? join(process.env.SystemRoot ?? "C:\\Windows", "System32")
  : "/usr/local/bin:/usr/bin:/bin";

for (const minimalPath of [false, true]) {
  test(`temporary bridge startup failure is saved${minimalPath ? " with systemd PATH" : ""}`, async () => {
    const home = mkdtempSync(join(tmpdir(), "isymcp-start-fail-"));
    const p = Bun.spawn([process.execPath, "run", join(import.meta.dir, "../src/isymcp.ts"), "canary"], {
      env: { ...process.env, DISPLAY: "", WAYLAND_DISPLAY: "", CODEX_WEB_HTTP_HOME: home, CODEX_WEB_HTTP_PORT: "1", CODEX_WEB_HTTP_WEB_MODELS: "invalid",
        ...(minimalPath ? { PATH: minimalPathValue } : {}) }, stdout: "pipe", stderr: "pipe",
    });
    const [exit, stderr] = await Promise.all([p.exited, new Response(p.stderr).text()]);
    expect(exit).toBe(1);
    expect(stderr).not.toContain('Executable not found in $PATH: "bun"');
    const result = JSON.parse(readFileSync(join(home, "canary/latest.json"), "utf8"));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("CODEX_WEB_HTTP_WEB_MODELS invalido");
    expect(result.notice).toMatchObject({ source: "isymcp", component: "canary.bridge.startup", event: "canary_failed", severity: "action_required" });
    expect(result.notice.summary).toBe("El bridge temporal no arranco: configuracion invalida.");
    expect(result.notice.summary).not.toContain("throw new Error");
    expect(result.notice.action).toBe("isymcp canary status");
    expect(JSON.parse(readFileSync(result.notice.evidence_ref, "utf8")).error).toContain("CODEX_WEB_HTTP_WEB_MODELS invalido");
    const html = renderMain({ ts: result.ts, server: "down", serverPort: "1", tunnel: "stopped", mcp: "down", browser: "ok", conversation: null, sessions: [], lastErrors: [], canary: result });
    expect(html).toContain("Origen: isymcp / canary.bridge.startup");
    expect(html).toContain(result.notice.summary);
    expect(html).toContain(result.notice.evidence_ref);
    expect(html).not.toContain("throw new Error");
  }, 30_000);
}


// Motivo del skip en Windows: el aviso de escritorio es una superficie que el producto
// solo implementa con DISPLAY/WAYLAND_DISPLAY + notify-send (src/canary.ts:213), y el
// cuerpo multilinea tampoco puede viajar por un lanzador .cmd (Bun lo rechaza). Lo que
// este test afirmaba de la NOTICIA (origen, accion, evidencia, sin stack) queda cubierto
// por el test de arriba, que si corre en ambos sistemas.
test.skipIf(process.platform === "win32")("desktop notice identifies origin and action without dumping the stack", async () => {
  const home = mkdtempSync(join(tmpdir(), "isymcp-notice-"));
  const bin = join(home, "bin");
  mkdirSync(bin);
  const recorded = join(home, "notification.json");
  // Substitute only the desktop command; run the real CLI and failure path.
  writeFileSync(join(bin, "notify-send"), `#!${process.execPath}
import {writeFileSync} from "node:fs"; writeFileSync(process.env.NOTICE_CAPTURE, JSON.stringify(process.argv.slice(2)));
`, { mode: 0o700 });
  const p = Bun.spawn([process.execPath, "run", join(import.meta.dir, "../src/isymcp.ts"), "canary"], {
    env: { ...process.env, PATH: bin + ":/usr/bin:/bin", DISPLAY: ":test", WAYLAND_DISPLAY: "", NOTICE_CAPTURE: recorded,
      CODEX_WEB_HTTP_HOME: home, CODEX_WEB_HTTP_PORT: "1", CODEX_WEB_HTTP_WEB_MODELS: "invalid" },
    stdout: "pipe", stderr: "pipe",
  });
  const [exit, stdout] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  expect(exit).toBe(1);
  const args = JSON.parse(readFileSync(recorded, "utf8")) as string[];
  expect(args[2]).toContain("ISYMCP");
  expect(args[3]).toContain("canary.bridge.startup");
  expect(args[3]).toContain("canary_failed");
  expect(args[3]).toContain("isymcp canary status");
  expect(args[3]).not.toContain("throw new Error");
  expect(stdout).toContain("Origen: isymcp / canary.bridge.startup");
  expect(stdout).toContain("Evidencia:");
});

// Model selection can finish hydrating a historical turn. The comparison
// baseline must be read after that preflight, immediately before seeding.
test("model preflight cannot make a historical answer look like a new reply", async () => {
  const start = source.indexOf("  await waitConversationSettle(page);", source.indexOf("async function sendWebTurnUnlocked"));
  const end = source.indexOf("  await composer.evaluate((el, text)", start);
  const prepare = new AsyncFunction("page", "options", "composer", "waitConversationSettle", "readLastAssistantSnapshot", "selectConnector",
    `${source.slice(start, end)}; return { beforeId, beforeText };`);
  let tail = { id: "old-loading", text: "" };
  const page = { keyboard: { press: async () => {} }, waitForTimeout: async () => {} };
  const baseline = await prepare(page, { connector: "", beforeSubmit: async () => {
    tail = { id: "old-hydrated", text: "Historical answer" };
  } }, { click: async () => {} }, async () => {}, async () => tail, async () => {});
  expect(baseline).toEqual({ beforeId: "old-hydrated", beforeText: "Historical answer" });
  expect(isNewAssistantTurn(baseline.beforeId, baseline.beforeText, tail.id, tail.text)).toBe(false);
});

test("a hidden stop control cannot exhaust the reply capture deadline", async () => {
  const start = source.indexOf("  let sawBusy = false;");
  const end = source.indexOf('  let text = "";', start);
  const waitForGeneration = new AsyncFunction("page", "Date", "deadline", "stopButton", "options", new Bun.Transpiler({ loader: "ts" }).transformSync(source.slice(start, end)) + "; return Date.now();");
  let now = 0;
  const completedAt = await waitForGeneration({ waitForTimeout: async (ms: number) => { now += ms; } }, { now: () => now }, 90000,
    { count: async () => 1, isVisible: async () => false }, {});
  expect(completedAt).toBeLessThan(90000);
});


test("a resumed generation cannot turn a stable 512-character prefix into a complete answer", async () => {
  let now = 0;
  const prefix = "x".repeat(512), complete = prefix + "y".repeat(512) + "\nFIN-CAPTURA-62";
  const snapshot = async () => ({ id: "new", text: now < 7000 ? prefix : complete });
  const reply = await capture({ waitForTimeout: async (ms: number) => { now += ms; } }, { now: () => now }, 15000, 500,
    "old", "OLD", async () => (await snapshot()).text, async () => "new", snapshot, isNewAssistantTurn,
    { isVisible: async () => now >= 1000 && now < 8000 });
  expect(reply).toBe(complete);
});

test("deadline during generation rejects a stable partial answer", async () => {
  let now = 0;
  const snapshot = async () => ({ id: "new", text: "x".repeat(512) });
  const reply = await capture({ waitForTimeout: async (ms: number) => { now += ms; } }, { now: () => now }, 6000, 500,
    "old", "OLD", async () => (await snapshot()).text, async () => "new", snapshot, isNewAssistantTurn,
    { isVisible: async () => true });
  expect(reply).toBe("");
});
