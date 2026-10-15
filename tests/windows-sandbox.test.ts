import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { expect, test } from "bun:test";
import { buildCodexWindowsSandboxPlan, cleanupCodexWindowsSandboxPath } from "../src/platform/codex-windows-sandbox";
import { buildWindowsDockerSandboxPlan } from "../src/platform/docker-sandbox";

test("native Windows profile is launchable by Codex and keeps the user profile denied", () => {
  const root = join(tmpdir(), `isymcp-native-plan-${randomUUID()}`);
  const workspace = join(root, "workspace");
  const cli = join(root, "codex.exe");
  const nativeCodexHome = join(root, "native-codex-home");
  const bridgeHome = join(root, "bridge-home");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(nativeCodexHome);
  mkdirSync(bridgeHome);
  writeFileSync(cli, "plan-only fake executable");
  const plan = buildCodexWindowsSandboxPlan({
    workspace,
    workdir: workspace,
    bridgeHome,
    command: ["cmd.exe", "/d", "/c", "echo ok"],
    writable: true,
    network: false,
    env: { ISYMCP_CODEX_CLI_BIN: cli, CODEX_HOME: nativeCodexHome, PATH: "" },
  });

  try {
    const config = readFileSync(join(plan.env.CODEX_HOME!, "config.toml"), "utf8");
    expect(plan.argv).toContain("sandbox");
    expect(plan.argv).not.toContain("--strict-config");
    expect(config).toContain('sandbox = "mxc"');
    expect(config).toContain('":root" = "read"');
    expect(config).toContain(`${JSON.stringify(homedir())} = "deny"`);
    expect(config).toContain(`${JSON.stringify(bridgeHome)} = "deny"`);
    expect(config).toContain(`${JSON.stringify(workspace)} = "write"`);
    expect(config).toContain('enabled = false');
  } finally {
    cleanupCodexWindowsSandboxPath(plan.cleanupRoot);
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows sandbox mounts only the chosen workspace and keeps its root read-only", () => {
  const plan = buildWindowsDockerSandboxPlan({
    dockerPath: "docker.exe",
    image: "isymcp-sandbox:test",
    workspace: "C:\\Dev Space\\project",
    workdir: "C:\\Dev Space\\project\\src",
    bridgeHome: "C:\\Users\\owner\\.codex-web-http",
    sourceRoot: "C:\\Program Files\\ISyMCP\\src",
    command: ["git", "status", "--short"],
    writable: false,
    env: { PATH: "C:\\Users\\private\\bin", TERM: "xterm-256color", LANG: "es_MX.UTF-8" },
    containerName: "isymcp-test-123",
  });

  expect(plan.argv).toContain("--network");
  expect(plan.argv[plan.argv.indexOf("--network") + 1]).toBe("none");
  expect(plan.argv).toContain("--read-only");
  expect(plan.argv).toContain("--cap-drop=ALL");
  expect(plan.argv).toContain("--security-opt=no-new-privileges");
  expect(plan.argv[plan.argv.indexOf("--user") + 1]).toBe("10001:10001");
  expect(plan.argv).toContain("--mount");
  expect(plan.argv).toContain("type=bind,source=C:/Dev Space/project,target=/workspace,readonly");
  expect(plan.argv).toContain("type=bind,source=C:/Program Files/ISyMCP/src,target=/opt/isymcp/src,readonly");
  expect(plan.argv).toContain("/workspace/src");
  expect(plan.argv.slice(-4)).toEqual(["isymcp-sandbox:test", "git", "status", "--short"]);
  expect(plan.argv).not.toContain("C:\\Users\\private\\bin");
});

test("Windows writable sessions expose only the workspace for writes and network stays opt-in", () => {
  const plan = buildWindowsDockerSandboxPlan({
    dockerPath: "docker.exe",
    image: "isymcp-sandbox:test",
    workspace: "D:\\work\\repo",
    workdir: "D:\\work\\repo",
    bridgeHome: "C:\\Users\\owner\\.codex-web-http",
    sourceRoot: "D:\\tools\\isymcp\\src",
    command: ["touch", "file.txt"],
    writable: true,
    env: { CODEX_WEB_HTTP_SANDBOX_NET: "1", TERM: "xterm" },
    containerName: "isymcp-test-456",
  });

  expect(plan.argv).toContain("type=bind,source=D:/work/repo,target=/workspace");
  expect(plan.argv).toContain("--network");
  expect(plan.argv[plan.argv.indexOf("--network") + 1]).toBe("bridge");
  expect(plan.containerName).toBe("isymcp-test-456");
});

test("Windows sandbox rejects mount paths Docker cannot parse without ambiguity", () => {
  expect(() => buildWindowsDockerSandboxPlan({
    dockerPath: "docker.exe",
    image: "isymcp-sandbox:test",
    workspace: "C:\\work,private\\repo",
    workdir: "C:\\work,private\\repo",
    bridgeHome: "C:\\Users\\owner\\.codex-web-http",
    sourceRoot: "C:\\tools\\isymcp\\src",
    command: ["git", "status"],
    writable: true,
    env: {},
    containerName: "isymcp-test-789",
  })).toThrow("windows_sandbox_path_unsupported");
});

test("Windows sandbox overlays bridge credentials when the workspace contains them", () => {
  const plan = buildWindowsDockerSandboxPlan({
    dockerPath: "docker.exe",
    image: "isymcp-sandbox:test",
    workspace: "C:\\work\\repo",
    workdir: "C:\\work\\repo",
    bridgeHome: "C:\\work\\repo\\.codex-web-http",
    sourceRoot: "C:\\tools\\isymcp\\src",
    command: ["sh", "-c", "cat .codex-web-http/codex-sessions.json"],
    writable: true,
    env: {},
    containerName: "isymcp-test-101",
  });

  expect(plan.argv).toContain("/workspace/.codex-web-http:rw,nosuid,nodev,size=16m");
});

test("Windows sandbox fails closed if the workspace is itself the bridge credential directory", () => {
  expect(() => buildWindowsDockerSandboxPlan({
    dockerPath: "docker.exe",
    image: "isymcp-sandbox:test",
    workspace: "C:\\work\\.codex-web-http",
    workdir: "C:\\work\\.codex-web-http",
    bridgeHome: "C:\\work\\.codex-web-http",
    sourceRoot: "C:\\tools\\isymcp\\src",
    command: ["git", "status"],
    writable: true,
    env: {},
    containerName: "isymcp-test-102",
  })).toThrow("windows_sandbox_bridge_home_conflicts_with_workspace");
});
