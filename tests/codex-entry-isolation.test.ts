import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Motivo del skip en Windows: aqui el "codex" falso es un guion que se EJECUTA, y
// spawnCodex() exige un .exe nativo real y lo lanza por node:child_process
// (src/platform/codex-windows-sandbox.ts:27-40, decision deliberada de no correr shims
// por cmd.exe). No hay sustituto sin compilar un ejecutable. Las afirmaciones que si
// son demostrables en Windows viven en tests/windows-sandbox.test.ts (plan de launch
// con ISYMCP_CODEX_CLI_BIN) y tests/codex-launcher.test.ts.
const isolationTest = test.skipIf(process.platform === "win32");

const entry = join(import.meta.dir, "..", "src", "isymcp.ts");

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "isymcp-cli-isolation-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "codex"), '#!/usr/bin/env bun\nconsole.log(JSON.stringify({codex_args:process.argv.slice(2)}));\n', { mode: 0o755 });
  // A real Codex process may refresh its cache concurrently. Test an owned
  // native home instead of treating the user's live cache as immutable.
  const nativeHome = join(dir, "native-codex");
  mkdirSync(nativeHome);
  writeFileSync(join(nativeHome, "config.toml"), 'model="native-fixture"\n');
  writeFileSync(join(nativeHome, "models_cache.json"), '{"fixture":"keep"}\n');
  return { dir, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CODEX_HOME: nativeHome, CODEX_WEB_HTTP_HOME: dir, CODEX_WEB_HTTP_PORT: "1" } };
}

async function run(args: string[], env: Record<string, string | undefined>) {
  const child = Bun.spawn([process.execPath, "run", entry, ...args], { env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { out, err, code };
}

isolationTest("native Codex command runs while the bridge is down and creates no bridge process", async () => {
  const { dir, env } = fixture();
  const result = await run(["codex", "exec", "-m", "gpt-6-luna", "native canary"], env);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.out).codex_args).toEqual(["exec", "-m", "gpt-6-luna", "native canary"]);
  expect(existsSync(join(dir, "run"))).toBe(false);
  expect(existsSync(join(dir, "codex-profiles"))).toBe(false);
});

isolationTest("Codex help does not start Web services", async () => {
  const { dir, env } = fixture();
  const result = await run(["codex", "--help"], env);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.out).codex_args).toEqual(["--help"]);
  expect(existsSync(join(dir, "run"))).toBe(false);
});

isolationTest("Web launcher selects its own provider and leaves global Codex files unchanged", async () => {
  const { dir, env } = fixture();
  const globalDir = env.CODEX_HOME;
  const paths = ["config.toml", "models_cache.json"].map(file => join(globalDir, file));
  const before = paths.map(path => existsSync(path) ? readFileSync(path) : null);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ status: "ok", web_models: "on", upstream: "fixture" }) });
  try {
    const result = await run(["codex", "exec", "Web canary"], { ...env, CODEX_WEB_HTTP_PORT: String(server.port) });
    expect(result.code).toBe(0);
    const args = JSON.parse(result.out).codex_args as string[];
    expect(args).toContain('model_provider="isymcp_web"');
    expect(args.some(arg => arg.startsWith("openai_base_url="))).toBe(false);
    expect(existsSync(join(dir, "codex-profiles", "isymcp-web", "profile.json"))).toBe(true);
    for (let i = 0; i < paths.length; i++) expect(existsSync(paths[i]!) ? readFileSync(paths[i]!) : null).toEqual(before[i]);
  } finally { server.stop(true); }
});
