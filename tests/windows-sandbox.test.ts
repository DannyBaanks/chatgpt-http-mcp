import { expect, test } from "bun:test";
import { buildWindowsDockerSandboxPlan } from "../src/platform/docker-sandbox";

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
