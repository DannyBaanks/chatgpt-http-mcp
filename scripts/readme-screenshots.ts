#!/usr/bin/env bun
// readme-screenshots.ts — regenera las capturas del README con DATOS DE DEMO.
//
// Nada real sale en las imagenes: HOME temporal con chats sembrados, un bridge
// FALSO (simula "escribiendo en vivo" y los ajustes de ChatGPT) y CLIs falsos
// para la tarjeta de harnesses. No toca ~/.codex-web-http ni chatgpt.com.
//
//   bun run scripts/readme-screenshots.ts        -> docs/images/*.png
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";

const ROOT = join(import.meta.dir, "..");
const OUT = join(ROOT, "docs", "images");
mkdirSync(OUT, { recursive: true });
// Ruta fija y legible: aparece en las capturas (carpeta de la sesion).
const demo = "/tmp/isymcp-demo";
rmSync(demo, { recursive: true, force: true });
mkdirSync(demo, { recursive: true });
process.env.CODEX_WEB_HTTP_HOME = join(demo, "home");
const { createChat, saveChat } = await import("../src/chats");
const { mintSession } = await import("../src/codex-sessions");
const { startPanel } = await import("../src/panel");

const ts = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const url = (n: string) => `https://chatgpt.com/c/${n}000000-demo-4000-8000-000000000000`;

// --- datos de demo ------------------------------------------------------------
const project = join(demo, "projects", "isyco-web");
mkdirSync(project, { recursive: true });
const session = mintSession(project, { label: "isyco-web", writable: true });

const ci = createChat("¿Por qué falló el CI?");
Object.assign(ci, {
  conversation_url: url("a1"), tools_enabled: true, session_fp: session.fp, updated_at: ts(2),
  messages: [
    { role: "user", ts: ts(4), text: "¿Por qué falló el CI? Revisa el último run y el test que rompió." },
    { role: "assistant", ts: ts(3), meta: {
      ms: 41_800, url: url("a1"), tools_enabled: true, tools: [
        { tool: "codex_exec", summary: "gh run view --log-failed", state: "ok", exit_code: 0, duration_ms: 1840 },
        { tool: "codex_exec", summary: "bun test tests/tui.test.ts", state: "failed", exit_code: 1, duration_ms: 612 },
      ] },
      text: [
        "Falló **un solo test**: `detectTuis > el host real detecta opencode`.",
        "",
        "- El runner de GitHub no tiene opencode instalado.",
        "- El test afirmaba algo sobre *tu* máquina, no sobre el código.",
        "",
        "Arreglo: saltarlo donde no hay opencode, sin fingir que pasa:",
        "",
        "```ts",
        "const hostHasOpencode = existsSync(join(homedir(), \".config\", \"opencode\"));",
        "test.skipIf(!hostHasOpencode)(\"el host real detecta opencode\", () => { /* … */ });",
        "```",
      ].join("\n") },
  ],
});
saveChat(ci);

const review = createChat("[claude-code] Segunda opinión sobre el diff de auth");
Object.assign(review, {
  conversation_url: url("b2"), updated_at: ts(30),
  messages: [
    { role: "user", ts: ts(32), text: "Revisa este diff de autenticación y dime si ves un riesgo." },
    { role: "assistant", ts: ts(31), meta: { ms: 22_400, url: url("b2") }, text: "Sí: el token se compara con `===`. Usa una comparación de **tiempo constante** (`timingSafeEqual`) para no filtrar su longitud por timing." },
  ],
});
saveChat(review);

const blocked = createChat("Leer el .env del proyecto");
Object.assign(blocked, {
  conversation_url: url("c3"), updated_at: ts(90),
  messages: [
    { role: "user", ts: ts(92), text: "Lee el .env y dime qué variables hay." },
    { role: "error", ts: ts(91), text: "Esta llamada a la herramienta se ha bloqueado por los controles de seguridad de OpenAI.", meta: { kind: "provider_blocked", ms: 18_200, url: url("c3") } },
  ],
});
saveChat(blocked);
saveChat({ ...createChat("Plan de la Fase 3"), updated_at: ts(600) });

// --- bridge falso -----------------------------------------------------------------
const LIVE = "Revisando el repo:\n\n1. `src/harness.ts` detecta **14** CLIs de agentes.\n2. Cinco traen su propio `mcp add`, así que";
let pendingChat: string | null = null;
// 8791 (el puerto real) si esta libre: es el que se ve en la ficha SERVER.
const bridgePort = await fetch("http://127.0.0.1:8791/health").then(() => 0, () => 8791);
const bridge = Bun.serve({
  hostname: "127.0.0.1", port: bridgePort,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/health") return Response.json({ status: "ok" });
    if (path === "/isymcp/settings") return Response.json({ state: "idle", last: null, seen: { pill: "High", model: "GPT-5.6 Sol", effort: "High", effortPosition: 3, effortSteps: 3, at: ts(0) } });
    if (path === "/isymcp/chat/status") {
      return Response.json(pendingChat
        ? { phase: "thinking", chat_id: pendingChat, queued: 0, since: ts(0), partial: LIVE,
            tools: [{ tool: "codex_exec", summary: "rg -n \"mcp add\" src/harness.ts", state: "ok", exit_code: 0, duration_ms: 38 }] }
        : { phase: "idle", chat_id: null, queued: 0, since: null });
    }
    if (path === "/isymcp/chat/turn") {
      pendingChat = ((await req.json()) as { chat_id: string }).chat_id;
      await Bun.sleep(60_000); // se queda "escribiendo" para la captura
      return Response.json({ ok: false });
    }
    return new Response("not found", { status: 404 });
  },
});

// CLIs falsos para la tarjeta de harnesses (dos ya conectados).
const bin = join(demo, "bin");
mkdirSync(bin);
const fake = (installed: boolean) => `#!/bin/sh\n[ "$2" = "list" ] || [ "$2" = "get" ] || exit 0\n${installed ? 'echo "isymcp-chatgpt: stdio"; exit 0' : 'echo "(none)"; exit 1'}\n`;
for (const [name, on] of [["claude", true], ["codex", true], ["qwen", false], ["gemini", false], ["grok", false], ["opencode", false], ["crush", false], ["cursor-agent", false], ["kimi", false]] as const) {
  writeFileSync(join(bin, name), fake(on), { mode: 0o755 });
}

// El panel detecta tunel y MCP con pgrep: dos procesos senuelo (un sleep con
// otro nombre) para que la demo los muestre en linea sin tocar los reales.
const decoys = [
  Bun.spawn(["bash", "-c", "exec -a 'tunnel-client run --profile demo' sleep 600"], { stdout: "ignore", stderr: "ignore" }),
  Bun.spawn(["bash", "-c", "exec -a 'bun src/mcp/main.ts --contract native --broker-socket demo' sleep 600"], { stdout: "ignore", stderr: "ignore" }),
];
await Bun.sleep(300);
const panel = startPanel(0, String(bridge.port));
const base = `http://127.0.0.1:${panel.port}`;
const browser = await chromium.launch({ executablePath: process.env.CODEX_WEB_HTTP_CHROME || "/usr/bin/google-chrome", headless: true });

async function open(width: number, height: number, hash: string): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
  await page.goto(`${base}/${hash}`);
  await page.waitForTimeout(700);
  return page;
}
const shot = (page: Page, name: string) => page.screenshot({ path: join(OUT, name) });

try {
  // 1. Chat con tarjetas de tool + markdown + ajustes sincronizados.
  let page = await open(1400, 860, "#chat");
  await page.locator(".chatlist button", { hasText: "CI" }).click();
  await page.waitForSelector(".toolcard");
  await page.waitForTimeout(800);
  await shot(page, "chat-tools.png");

  // 2. Texto en vivo: se envia un mensaje y el bridge falso "escribe".
  await page.locator(".chatlist button", { hasText: "Plan de la Fase 3" }).click();
  await page.waitForTimeout(400);
  await page.fill("#input", "¿Qué harnesses soporta ya el motor?");
  await page.press("#input", "Enter");
  await page.waitForSelector(".live-body", { timeout: 10_000 });
  await page.waitForTimeout(2600);
  await shot(page, "chat-live.png");
  await page.close();

  // 3. Errores con origen claro.
  page = await open(1400, 560, "#chat");
  await page.locator(".chatlist button", { hasText: ".env" }).click();
  await page.waitForSelector(".errcard");
  await shot(page, "chat-blocked.png");
  await page.close();

  // 4. Estado (dashboard).
  page = await open(1400, 1000, "#estado");
  await page.waitForTimeout(800);
  await shot(page, "status.png");

  // 5. Harnesses: detectar con los CLIs falsos y abrir el plan.
  process.env.PATH = `${bin}:/usr/bin:/bin`;
  await page.click("#harness-detect");
  await page.waitForSelector(".hrow");
  await page.check('.hrow input[value="qwen"]');
  await page.check('.hrow input[value="gemini"]');
  await page.click("#harness-plan-install");
  await page.waitForSelector(".planbox pre");
  await page.locator("#harness-card").screenshot({ path: join(OUT, "harnesses.png") });
  await page.close();

  // 6. Movil.
  page = await open(390, 844, "#chat");
  await page.click("#btn-side");
  await page.waitForTimeout(300);
  await page.locator(".chatlist button", { hasText: "Segunda opinión" }).click();
  await page.waitForTimeout(600);
  await shot(page, "mobile.png");
  await page.close();
} finally {
  await browser.close();
  for (const d of decoys) d.kill();
  panel.stop(true);
  bridge.stop(true);
  rmSync(demo, { recursive: true, force: true });
}
console.log(`capturas en ${OUT}`);
process.exit(0);
