import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeGateway, nativeRpc } from "../src/mcp/active-native";
import { canaryCommand } from "../src/mcp/current-owner-canary";

test("cancelling a delivered canary revokes authorization and promptly exits its controller", async () => {
  if (process.platform !== "linux") return;
  const home = mkdtempSync(join(tmpdir(), "isymcp-controller-unit-")), directory = join(home, "probe");
  const script = join(import.meta.dir, "../scripts/probe-current-owner-browser.ts");
  const thread = "00000000-0000-4000-8000-000000000001", turn = "00000000-0000-4000-8000-000000000002";
  const env = { ...process.env, CODEX_WEB_HTTP_HOME: home, CODEX_THREAD_ID: thread, CODEX_PERMISSION_PROFILE: ":danger-full-access" };
  // Synthetic owner metadata is confined to this local protocol unit test;
  // no browser, remote MCP, native command or model is started.
  const proc = Bun.spawn([process.execPath, script, "start", "--directory", directory,
    "--thread-id", thread, "--turn-id", turn, "--cwd", home + "/"], { env, stdout: "ignore", stderr: "ignore" });
  async function waitFor(file: string) {
    const end = Date.now() + 3000;
    while (!existsSync(join(directory, file))) {
      if (Date.now() > end) throw Error("controller_fixture_not_ready");
      await Bun.sleep(10);
    }
    return JSON.parse(readFileSync(join(directory, file), "utf8"));
  }
  let invoke: Promise<any> | undefined;
  try {
    const grant = await waitFor("owner-private.json");
    const state = await waitFor("status.json");
    const binding = await nativeRpc(grant.socket, { method: "claim", token: grant.token, contract: "native", activityId: "activity_unit" });
    invoke = nativeRpc(grant.socket, { method: "invoke", bindingId: binding.bindingId,
      wireName: "exec", freeform: true, input: nativeGateway(canaryCommand(state.marker), home) }).catch(() => null);
    await waitFor("delivery.json");
    const cancel = Bun.spawn([process.execPath, script, "cancel", "--directory", directory], { env, stdout: "ignore", stderr: "ignore" });
    expect(await cancel.exited).toBe(0);
    const closed = await Promise.race([proc.exited, Bun.sleep(1500).then(() => "still-running")]);
    expect(closed).toBe(0);
    expect(JSON.parse(readFileSync(join(directory, "status.json"), "utf8")).phase).toBe("cancelled");
    expect(existsSync(join(directory, "native-result.json"))).toBe(false);
  } finally {
    proc.kill(); await proc.exited; await invoke;
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000); // Spawns a controller and waits on filesystem fixtures; 0.2s quiet but >8s under load.
