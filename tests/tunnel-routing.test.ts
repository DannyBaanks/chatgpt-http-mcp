import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertExclusiveTunnel, configuredTunnelAlias } from "../src/tunnel-routing";

test("a stale alias sharing a live app's remote tunnel cannot connect or stop it", () => {
  const id = `tunnel_${"a".repeat(32)}`, separate = `tunnel_${"b".repeat(32)}`;
  const inventory = { aliases: [{ alias: "codex-web-http", tunnel_id: id }, { alias: "codex-chatgpt-web", tunnel_id: id }] };
  expect(() => assertExclusiveTunnel(inventory, "codex-web-http")).toThrow("tunnel_identity_shared");
  expect(() => assertExclusiveTunnel(inventory, "isymcp-native-media", id)).toThrow("tunnel_identity_shared");
  expect(() => assertExclusiveTunnel(inventory, "isymcp-native-media", separate)).not.toThrow();
  expect(() => assertExclusiveTunnel({}, "codex-web-http", id)).toThrow("tunnel_inventory_invalid");
  expect(() => assertExclusiveTunnel({ aliases: [] }, "unknown")).toThrow("tunnel_identity_missing");
});

test("lifecycle commands resolve the persisted separate alias and reject unsafe alias names", () => {
  const home = mkdtempSync(join(tmpdir(), "tunnel-route-"));
  expect(configuredTunnelAlias(home)).toBe("codex-web-http");
  writeFileSync(join(home, "tunnel.json"), JSON.stringify({ alias: "isymcp-native-media" }));
  expect(configuredTunnelAlias(home)).toBe("isymcp-native-media");
  expect(configuredTunnelAlias(home, "explicit")).toBe("explicit");
  expect(() => configuredTunnelAlias(home, "../foreign")).toThrow("tunnel_alias_invalid");
});

function connectFixture(shared: boolean) {
  const home = mkdtempSync(join(tmpdir(), "tunnel-connect-"));
  mkdirSync(join(home, "bin")); mkdirSync(join(home, "secrets"));
  const id = `tunnel_${"a".repeat(32)}`;
  writeFileSync(join(home, "tunnel.json"), JSON.stringify({ alias: "isymcp-native-media", tunnelId: id }));
  writeFileSync(join(home, "secrets", "tunnel-runtime.key"), "fixture-only");
  const calls = join(home, "calls.jsonl");
  const inventory = { aliases: shared ? [{ alias: "foreign-app", tunnel_id: id }] : [] };
  writeFileSync(join(home, "bin", "tunnel-client"), `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';
const args=process.argv.slice(2);appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');
console.log(JSON.stringify(args[1]==='list'?${JSON.stringify(inventory)}:{running:true,ready:true,runtime_state:'ready'}));\n`, { mode: 0o700 });
  const run = () => Bun.spawnSync([process.execPath, join(import.meta.dir, "../scripts/connect-tunnel.ts"), "--org-file", join(home, "absent-org.txt")], {
    env: { ...process.env, CODEX_WEB_HTTP_HOME: home }, timeout: 10_000,
  });
  return { home, calls, run };
}

test("existing tunnel attachment needs no admin organization file and preserves its separate alias", () => {
  const f = connectFixture(false), result = f.run();
  expect(result.exitCode).toBe(0);
  const calls = readFileSync(f.calls, "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(calls.map(args => args[1])).toEqual(["list", "connect"]);
  expect(calls[1]).toContain("isymcp-native-media");
  expect(calls[1]).not.toContain("--organization-id");
  expect(calls[1][calls[1].indexOf("--runtime-api-key") + 1]).toStartWith("file:");
  expect(JSON.parse(readFileSync(join(f.home, "tunnel.json"), "utf8")).alias).toBe("isymcp-native-media");
});

test("connect refuses a foreign runtime before replacing its launcher or publishing metadata", () => {
  const f = connectFixture(true), launcher = join(f.home, "bin", "isymcp-mcp");
  writeFileSync(launcher, "preserve launcher");
  const before = readFileSync(join(f.home, "tunnel.json"), "utf8");
  const result = f.run();
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("tunnel_identity_shared");
  expect(readFileSync(launcher, "utf8")).toBe("preserve launcher");
  expect(readFileSync(join(f.home, "tunnel.json"), "utf8")).toBe(before);
  expect(existsSync(f.calls)).toBe(true);
  expect(readFileSync(f.calls, "utf8").trim().split("\n")).toHaveLength(1);
});
