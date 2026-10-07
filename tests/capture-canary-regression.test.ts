import { expect, test } from "bun:test";
import { readFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
test("missing identity is not evidence that the old answer is new", () => {
  expect(isNewAssistantTurn("old", "OLD", "", "OLD")).toBe(false);
});

test("missing previous identity does not make unchanged previous text new", () => {
  expect(isNewAssistantTurn("", "OLD", "", "OLD")).toBe(false);
});

// Run the actual capture loop on a virtual clock; no real browser or long wait.
const loop = source.slice(source.indexOf('  let text = "";', source.indexOf("const graceUntil")), source.indexOf("  if (!text.trim()) await dumpCaptureFailure"));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const capture = new AsyncFunction("page", "Date", "deadline", "settleMs", "beforeId", "beforeText", "readLastAssistant", "lastAssistantIdentity", "readLastAssistantSnapshot", "isNewAssistantTurn", `${loop}; return text;`);
async function captureFrames(frames: string[], deadline: number) {
  let now = 0;
  let index = 0;
  const snapshot = async () => ({ id: "new", text: frames[Math.min(index++, frames.length - 1)] });
  return capture({ waitForTimeout: async (ms: number) => { now += ms; } }, { now: () => now }, deadline, 500, "old", "OLD",
    async () => (await snapshot()).text, async () => "new", snapshot, isNewAssistantTurn);
}
test("deadline rejects a changing partial response without stable proof", async () => {
  expect(await captureFrames(["N", "NE", "NEW"], 1500)).toBe("");
});
test("completed stable new answer is returned", async () => {
  expect(await captureFrames(["NEW"], 5000)).toBe("NEW");
});

for (const minimalPath of [false, true]) {
  test(`temporary bridge startup failure is saved${minimalPath ? " with systemd PATH" : ""}`, async () => {
    const home = mkdtempSync(join(tmpdir(), "isymcp-start-fail-"));
    const p = Bun.spawn([process.execPath, "run", join(import.meta.dir, "../src/isymcp.ts"), "canary"], {
      env: { ...process.env, DISPLAY: "", WAYLAND_DISPLAY: "", CODEX_WEB_HTTP_HOME: home, CODEX_WEB_HTTP_PORT: "1", CODEX_WEB_HTTP_WEB_MODELS: "invalid",
        ...(minimalPath ? { PATH: "/usr/local/bin:/usr/bin:/bin" } : {}) }, stdout: "pipe", stderr: "pipe",
    });
    const [exit, stderr] = await Promise.all([p.exited, new Response(p.stderr).text()]);
    expect(exit).toBe(1);
    expect(stderr).not.toContain('Executable not found in $PATH: "bun"');
    const result = JSON.parse(readFileSync(join(home, "canary/latest.json"), "utf8"));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("CODEX_WEB_HTTP_WEB_MODELS invalido");
  }, 30_000);
}
