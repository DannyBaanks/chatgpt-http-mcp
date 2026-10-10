import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCodexArgs, installDesktopLauncher, isBridgeAlive, removeDesktopLauncher, usesWebBridge } from "../src/codex-launcher";

let tempDir: string;
let fakeBridge: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "codex-launcher-test-"));
  fakeBridge = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      if (new URL(req.url).pathname === "/health") {
        return Response.json({ status: "ok", web_models: "on", upstream: "https://chatgpt.com/backend-api/codex" });
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
  test("Web selects a named provider without redirecting the builtin OpenAI provider", () => {
    const args = buildCodexArgs(["--model", "chatgpt-web/gpt-5.6-sol", "hola"], "18791");
    expect(args).toContain('model_provider="isymcp_web"');
    expect(args.join(" ")).toContain('base_url="http://127.0.0.1:18791/v1"');
    expect(args.some(arg => arg.startsWith("openai_base_url="))).toBe(false);
    expect(args.slice(-3)).toEqual(["--model", "chatgpt-web/gpt-5.6-sol", "hola"]);
  });

  test("explicit native models bypass the bridge even through the ISyMCP launcher", () => {
    for (const args of [["exec", "-m", "gpt-6-luna", "hola"], ["resume", "thread", "--model=gpt-6.1-sol"], ["-c", 'model="gpt-6-luna"'], ["exec", "-mgpt-6-luna", "hola"], ["-m=gpt-6-luna"], ['-cmodel="gpt-6-luna"'], ['-c=model="gpt-6-luna"']]) {
      expect(buildCodexArgs(args, "18791")).toEqual(args);
    }
    expect(buildCodexArgs([], "18791")).toContain('model="chatgpt-web/gpt-5.6-sol"');
    expect(buildCodexArgs(["--", "--model=gpt-6-luna"], "18791")).toContain('model_provider="isymcp_web"');
    expect(buildCodexArgs(["--", "--help"], "18791")).toContain('model_provider="isymcp_web"');
  });

  test("native TOML model overrides allow whitespace around the assignment", () => {
    for (const args of [
      ["exec", "-c", 'model = "gpt-6-luna"', "hola"],
      ["--config", ' model\t=\t"gpt-6.1-sol" '],
      ['--config=model = "gpt-6-luna"'],
      ['-cmodel = "gpt-6-luna"'],
      ['-c=model = "gpt-6-luna"'],
      ["-c", "model = 'gpt-6-luna'"],
    ]) {
      expect(buildCodexArgs(args, "18791")).toEqual(args);
    }
  });

  test("an explicit profile owns its configuration unless a Web model is also requested", () => {
    for (const profile of [
      ["-p", "native"],
      ["--profile", "native"],
      ["--profile=native"],
      ["-pnative"],
      ["-p=native"],
      ["--profile", "user-web-profile"],
    ]) {
      const args = ["exec", ...profile, "hola"];
      expect(usesWebBridge(args)).toBe(false);
      // A preserved profile must not even need a valid Web port.
      expect(buildCodexArgs(args, "not-a-port")).toEqual(args);
    }
  });

  test("explicit Web models opt a selected profile into the isolated bridge", () => {
    for (const model of [
      ["-m", "chatgpt-web/gpt-5.6-sol"],
      ["--model=chatgpt-web/gpt-6"],
      ["-c", 'model = "chatgpt-web/gpt-5.6-sol"'],
    ]) {
      const original = ["exec", "--profile", "native", ...model, "hola"];
      const args = buildCodexArgs(original, "18791");
      expect(usesWebBridge(original)).toBe(true);
      expect(args).toContain('model_provider="isymcp_web"');
      expect(args.slice(-original.length)).toEqual(original);
    }
  });

  test("profile routing preserves CLI model precedence and excludes prompt text after --", () => {
    const nativeFlag = ["--profile=native", "-c", 'model = "chatgpt-web/gpt-5.6-sol"', "--model=gpt-6-luna"];
    expect(buildCodexArgs(nativeFlag, "18791")).toEqual(nativeFlag);
    const webFlag = ["-pnative", "-c", 'model = "gpt-6-luna"', "--model=chatgpt-web/gpt-6"];
    expect(buildCodexArgs(webFlag, "18791")).toContain('model_provider="isymcp_web"');
    const prompt = ["--", "--profile=native", "-p", "native"];
    const args = buildCodexArgs(prompt, "18791");
    expect(args).toContain('model_provider="isymcp_web"');
    expect(args.slice(-prompt.length)).toEqual(prompt);
  });

  test("spaced Web reasoning overrides still reject unverified effort", () => {
    for (const args of [
      ["-c", 'model_reasoning_effort = "low"'],
      ["--config", ' model_reasoning_effort\t=\t"low" '],
      ['--config=model_reasoning_effort = "low"'],
    ]) {
      expect(() => buildCodexArgs(args, "18791")).toThrow("modelo y esfuerzo Web verificado");
    }
  });

  test("spaced config overrides preserve model flag precedence and the prompt delimiter", () => {
    const nativeFlag = ["-c", 'model = "chatgpt-web/gpt-5.6-sol"', "--model=gpt-6-luna"];
    expect(buildCodexArgs(nativeFlag, "18791")).toEqual(nativeFlag);
    const webFlag = ["-c", 'model = "gpt-6-luna"', "--model=chatgpt-web/gpt-5.6-sol"];
    expect(buildCodexArgs(webFlag, "18791")).toContain('model_provider="isymcp_web"');
    const prompt = ["--", "-c", 'model = "gpt-6-luna"', "-c", 'model_reasoning_effort = "low"'];
    const args = buildCodexArgs(prompt, "18791");
    expect(args).toContain('model_provider="isymcp_web"');
    expect(args.slice(-prompt.length)).toEqual(prompt);
  });

  test("an unauthenticated or unrelated health response is not a ready Web bridge", async () => {
    for (const response of [new Response("", { status: 401 }), Response.json({ status: "ok" }), Response.json({ status: "ok", web_models: "off" })]) {
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => response.clone() });
      try { expect(await isBridgeAlive(String(server.port))).toBe(false); }
      finally { server.stop(true); }
    }
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
    expect(binContent).toContain('exec isymcp codex "$@"');
    expect(binContent).not.toContain("openai_base_url");
    expect(binContent).toContain('CODEX_WEB_HTTP_PORT="${CODEX_WEB_HTTP_PORT:-8791}"');

    const desktopContent = readFileSync(installed.desktopPath, "utf8");
    expect(desktopContent).toContain("[Desktop Entry]");
    expect(desktopContent).toContain("Name=Codex (ISyMCP Web)");
    expect(desktopContent).toContain("Terminal=true");
    expect(desktopContent).not.toContain("%U");

    const removed = removeDesktopLauncher({ binDir, appDir });
    expect(removed.removedBin).toBe(true);
    expect(removed.removedDesktop).toBe(true);
    expect(existsSync(installed.binPath)).toBe(false);
    expect(existsSync(installed.desktopPath)).toBe(false);
  });
});
