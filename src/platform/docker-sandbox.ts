import { posix, win32 } from "node:path";

export interface WindowsDockerSandboxInput {
  dockerPath: string;
  image: string;
  workspace: string;
  workdir: string;
  bridgeHome: string;
  /** Read-only ISyMCP source mount used by the native patch helper. */
  sourceRoot: string;
  command: string[];
  writable: boolean;
  env: Record<string, string | undefined>;
  containerName: string;
}

export interface WindowsDockerSandboxPlan {
  argv: string[];
  containerName: string;
}

const CONTAINER_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const CONTAINER_HOME = "/home/isymcp";
const CONTAINER_WORKSPACE = "/workspace";
const CONTAINER_SOURCE = "/opt/isymcp/src";
const ENV_ALLOWLIST = ["LANG", "LC_ALL", "TERM", "TZ"];

function mountSource(value: string): string {
  if (!win32.isAbsolute(value) || value.startsWith("\\\\") || value.includes(",")) {
    throw Error("windows_sandbox_path_unsupported");
  }
  return win32.normalize(value).replaceAll("\\", "/");
}

function containerWorkdir(workspace: string, workdir: string): string {
  const relative = win32.relative(win32.normalize(workspace), win32.normalize(workdir));
  if (relative === ".." || relative.startsWith(`..${win32.sep}`) || win32.isAbsolute(relative)) {
    throw Error("windows_sandbox_workdir_outside_workspace");
  }
  return relative ? posix.join(CONTAINER_WORKSPACE, relative.split(win32.sep).join(posix.sep)) : CONTAINER_WORKSPACE;
}

function hiddenBridgePath(workspace: string, bridgeHome: string): string | null {
  if (!win32.isAbsolute(bridgeHome) || bridgeHome.startsWith("\\\\")) return null;
  const relative = win32.relative(win32.normalize(workspace), win32.normalize(bridgeHome));
  if (relative === ".." || relative.startsWith(`..${win32.sep}`) || win32.isAbsolute(relative)) return null;
  if (!relative) throw Error("windows_sandbox_bridge_home_conflicts_with_workspace");
  return posix.join(CONTAINER_WORKSPACE, relative.split(win32.sep).join(posix.sep));
}

function environmentArgs(env: WindowsDockerSandboxInput["env"]): string[] {
  const names = [...ENV_ALLOWLIST];
  const extra = (env.CODEX_WEB_HTTP_SANDBOX_ENV ?? "").split(",").map(value => value.trim());
  for (const name of extra) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !["PATH", "HOME"].includes(name) && !names.includes(name)) names.push(name);
  }
  const args = ["--env", `PATH=${CONTAINER_PATH}`, "--env", `HOME=${CONTAINER_HOME}`];
  for (const name of names) {
    const value = env[name];
    if (value !== undefined) args.push("--env", `${name}=${value}`);
  }
  return args;
}

export function buildWindowsDockerSandboxPlan(input: WindowsDockerSandboxInput): WindowsDockerSandboxPlan {
  if (!input.dockerPath || !input.image || !input.command.length || input.command.some(value => value.includes("\0")) ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(input.containerName)) {
    throw Error("windows_sandbox_configuration_invalid");
  }
  const workspace = mountSource(input.workspace);
  const sourceRoot = mountSource(input.sourceRoot);
  const args = [
    input.dockerPath, "run", "--rm", "--interactive", "--init", "--name", input.containerName,
    "--label", "com.isymcp.sandbox=true", "--label", `com.isymcp.sandbox.pid=${process.pid}`,
    "--network", input.env.CODEX_WEB_HTTP_SANDBOX_NET?.trim() === "1" ? "bridge" : "none",
    "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
    "--pids-limit", "128", "--memory", "1g", "--cpus", "2",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m",
    "--tmpfs", `${CONTAINER_HOME}:rw,nosuid,nodev,size=32m`,
    "--user", "10001:10001",
    ...environmentArgs(input.env),
    "--mount", `type=bind,source=${workspace},target=${CONTAINER_WORKSPACE}${input.writable ? "" : ",readonly"}`,
    "--mount", `type=bind,source=${sourceRoot},target=${CONTAINER_SOURCE},readonly`,
    ...(hiddenBridgePath(input.workspace, input.bridgeHome)
      ? ["--tmpfs", `${hiddenBridgePath(input.workspace, input.bridgeHome)}:rw,nosuid,nodev,size=16m`]
      : []),
    "--workdir", containerWorkdir(input.workspace, input.workdir),
    input.image,
    ...input.command,
  ];
  return { argv: args, containerName: input.containerName };
}
