import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCodexArgs, installDesktopLauncher, isBridgeAlive, removeDesktopLauncher } from "../src/codex-launcher";

let tempDir: string;
let fakeBridge: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "codex-launcher-test-"));
  fakeBridge = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      if (new URL(req.url).pathname === "/health") {
        return Response.json({ status: "ok" });
      }
      return new Response("not found", { status: 404 });
    },
  });
});

afterAll(() => {
  fakeBridge.stop(true);
  rmSync(tempDir, { recursive: true, force: true });
});

describe("codex-launcher (perfil aislado sin tocar config.toml)", () => {
  test("buildCodexArgs construye los argumentos con -c openai_base_url de forma efímera", () => {
    const args = buildCodexArgs(["--model", "chatgpt-web/gpt-5.6-sol", "hola"], "18791");
    expect(args).toEqual([
      "-c",
      'openai_base_url="http://127.0.0.1:18791/v1"',
      "--model",
      "chatgpt-web/gpt-5.6-sol",
      "hola",
    ]);
  });

  test("isBridgeAlive detecta el bridge activo en el puerto dado", async () => {
    const alive = await isBridgeAlive(String(fakeBridge.port));
    expect(alive).toBe(true);

    const dead = await isBridgeAlive("1");
    expect(dead).toBe(false);
  });

  test("installDesktopLauncher y removeDesktopLauncher instalan y limpian lanzadores aislados", () => {
    const binDir = join(tempDir, "bin");
    const appDir = join(tempDir, "applications");

    const installed = installDesktopLauncher({ binDir, appDir, port: "8791" });
    expect(existsSync(installed.binPath)).toBe(true);
    expect(existsSync(installed.desktopPath)).toBe(true);

    const binContent = readFileSync(installed.binPath, "utf8");
    expect(binContent).toContain("codex -c openai_base_url=");
    expect(binContent).toContain("PORT=\"${CODEX_WEB_HTTP_PORT:-8791}\"");

    const desktopContent = readFileSync(installed.desktopPath, "utf8");
    expect(desktopContent).toContain("[Desktop Entry]");
    expect(desktopContent).toContain("Name=Codex (ISyMCP Web)");
    expect(desktopContent).toContain(`Exec=${installed.binPath} %U`);

    const removed = removeDesktopLauncher({ binDir, appDir });
    expect(removed.removedBin).toBe(true);
    expect(removed.removedDesktop).toBe(true);
    expect(existsSync(installed.binPath)).toBe(false);
    expect(existsSync(installed.desktopPath)).toBe(false);
  });
});
