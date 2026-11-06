import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, resolve, win32 } from "node:path";
import { ensurePrivatePath, securePrivatePath } from "./private-path";

const POLICY_ROOT_NAME = "isymcp-windows-sandbox";
const PROFILE = "isymcp";

export interface CodexWindowsSandboxInput {
  workspace: string;
  workdir: string;
  bridgeHome: string;
  command: string[];
  writable: boolean;
  network: boolean;
  readPaths?: string[];
  env?: NodeJS.ProcessEnv;
}

export interface CodexWindowsSandboxPlan {
  argv: string[];
  env: Record<string, string>;
  cleanupRoot: string;
}

function regularExe(path: string): boolean {
  if (win32.extname(path).toLowerCase() !== ".exe") return false;
  try { return statSync(path).isFile(); } catch { return false; }
}

/** Locate only the native executable; do not execute command shims through cmd.exe. */
export function findCodexWindowsCli(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env.ISYMCP_CODEX_CLI_BIN?.trim();
  if (configured) return regularExe(configured) ? win32.resolve(configured) : null;

  for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(dir, "codex.exe");
    if (regularExe(candidate)) return win32.resolve(candidate);
  }

  const appBin = env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "OpenAI", "Codex", "bin") : "";
  if (appBin && existsSync(appBin)) {
    try {
      const candidates = readdirSync(appBin, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(appBin, entry.name, "codex.exe"))
        .filter(regularExe);
      candidates.sort((a, b) => b.localeCompare(a));
      if (candidates[0]) return win32.resolve(candidates[0]);
    } catch { /* remain fail-closed */ }
  }

  const npmCodex = env.APPDATA
    ? join(env.APPDATA, "npm", "node_modules", "@openai", "codex", "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin",
      "codex.exe")
    : "";
  return npmCodex && regularExe(npmCodex) ? win32.resolve(npmCodex) : null;
}

function absoluteLocalPath(path: string): string {
  const normalized = win32.normalize(win32.resolve(path));
  if (!/^[A-Za-z]:\\/.test(normalized)) throw Error("windows_sandbox_path_unsupported");
  return normalized;
}

function within(parent: string, child: string): boolean {
  const relative = win32.relative(parent.toLowerCase(), child.toLowerCase());
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${win32.sep}`) && !win32.isAbsolute(relative));
}

function samePath(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function tomlString(value: string): string {
  // JSON basic strings are valid TOML basic strings and escape Windows paths.
  return JSON.stringify(value);
}

function privatePolicyRoot(): string {
  const root = join(tmpdir(), POLICY_ROOT_NAME);
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  ensurePrivatePath(root, true);
  return root;
}

function commandEnvironment(env: NodeJS.ProcessEnv, codexHome: string, scratch: string): Record<string, string> {
  const allowed = new Set([
    "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
    "LOCALAPPDATA", "APPDATA", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS", "LANG", "LC_ALL", "TERM", "TZ",
  ]);
  const protectedNames = new Set(["PATH", "HOME", "USERPROFILE", "CODEX_HOME", "TEMP", "TMP", "SYSTEMROOT", "WINDIR", "COMSPEC", "APPDATA", "LOCALAPPDATA"]);
  for (const name of (env.CODEX_WEB_HTTP_SANDBOX_ENV ?? "").split(",").map((part) => part.trim())) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !protectedNames.has(name.toUpperCase())) allowed.add(name);
  }

  const output: Record<string, string> = {};
  for (const name of allowed) {
    const value = env[name];
    if (value !== undefined) output[name] = value;
  }
  output.CODEX_HOME = codexHome;
  output.HOME = scratch;
  output.TEMP = scratch;
  output.TMP = scratch;
  output.GIT_CONFIG_NOSYSTEM = "1";
  output.GIT_CONFIG_GLOBAL = join(scratch, ".gitconfig");
  return output;
}

function policyConfig(input: {
  workspace: string;
  bridgeHome: string;
  nativeCodexHome: string;
  userHome: string;
  profileHome: string;
  scratch: string;
  pathDirectories: string[];
  readPaths: string[];
  writable: boolean;
  network: boolean;
}): string {
  const protectedPaths = [
    input.bridgeHome,
    input.nativeCodexHome,
    input.profileHome,
    join(homedir(), ".ssh"),
    join(homedir(), ".aws"),
    join(homedir(), ".azure"),
    join(homedir(), ".kube"),
    join(homedir(), ".docker"),
    join(homedir(), ".git-credentials"),
    join(homedir(), ".npmrc"),
    join(homedir(), ".pypirc"),
  ].map(absoluteLocalPath);

  if (protectedPaths.some((path) => samePath(path, input.workspace) || within(path, input.workspace) || within(input.workspace, path))) {
    throw Error("windows_sandbox_workspace_conflicts_with_private_data");
  }

  // MXC needs a readable root to resolve --cd. Deny the user's profile and
  // reopen only the authorized workspace, scratch directory, and PATH entries.
  const deniedPaths = [...protectedPaths, absoluteLocalPath(input.userHome)];
  const denied = [...new Set(deniedPaths.map((path) => path.toLowerCase()))]
    .map((path) => deniedPaths.find((candidate) => candidate.toLowerCase() === path)!)
    .map((path) => `${tomlString(path)} = "deny"`);
  const pathReads = [...new Set([...input.pathDirectories, ...input.readPaths].map((path) => path.toLowerCase()))]
    .filter((path) => !protectedPaths.some((protectedPath) => within(protectedPath, path) || within(path, protectedPath)))
    .filter((path) => !within(input.workspace, path) && !within(path, input.workspace))
    .map((path) => `${tomlString(path)} = "read"`);
  const workspaceAccess = input.writable ? "write" : "read";
  return [
    `default_permissions = ${tomlString(PROFILE)}`,
    "",
    "[windows]",
    'sandbox = "mxc"',
    "",
    `[permissions.${PROFILE}.filesystem]`,
    '":root" = "read"',
    '":minimal" = "read"',
    `${tomlString(input.workspace)} = ${tomlString(workspaceAccess)}`,
    `${tomlString(input.scratch)} = "write"`,
    ...pathReads,
    ...denied,
    "",
    `[permissions.${PROFILE}.network]`,
    `enabled = ${input.network ? "true" : "false"}`,
    "",
  ].join("\n");
}

export function buildCodexWindowsSandboxPlan(input: CodexWindowsSandboxInput): CodexWindowsSandboxPlan {
  if (!input.command.length || input.command.some((part) => part.includes("\0"))) throw Error("windows_sandbox_configuration_invalid");
  const cli = findCodexWindowsCli(input.env);
  if (!cli) throw Error("windows_sandbox_codex_cli_missing");

  const workspace = absoluteLocalPath(input.workspace);
  const workdir = absoluteLocalPath(input.workdir);
  const bridgeHome = absoluteLocalPath(input.bridgeHome);
  const nativeCodexHome = absoluteLocalPath(input.env?.CODEX_HOME?.trim() || join(homedir(), ".codex"));
  if (!within(workspace, workdir) || samePath(workspace, bridgeHome) || samePath(workspace, nativeCodexHome) ||
      within(workspace, bridgeHome) || within(workspace, nativeCodexHome)) {
    throw Error("windows_sandbox_workspace_invalid");
  }

  const root = privatePolicyRoot();
  const cleanupRoot = join(root, `run-${randomUUID()}`);
  mkdirSync(cleanupRoot);
  securePrivatePath(cleanupRoot, true);
  try {
    const codexHome = join(cleanupRoot, "codex-home");
    const scratch = join(cleanupRoot, "scratch");
    mkdirSync(codexHome);
    mkdirSync(scratch);
    securePrivatePath(codexHome, true);
    securePrivatePath(scratch, true);
    writeFileSync(join(scratch, ".gitconfig"), "", { encoding: "utf8", flag: "wx", mode: 0o600 });

    const configPath = join(codexHome, "config.toml");
    const protectedRoots = [
      bridgeHome,
      nativeCodexHome,
      join(homedir(), ".ssh"),
      join(homedir(), ".aws"),
      join(homedir(), ".azure"),
      join(homedir(), ".kube"),
      join(homedir(), ".docker"),
      join(homedir(), ".git-credentials"),
      join(homedir(), ".npmrc"),
      join(homedir(), ".pypirc"),
    ].map(absoluteLocalPath);
    const pathDirectories = [...new Set((input.env?.PATH ?? process.env.PATH ?? "")
      .split(delimiter)
      .filter(Boolean)
      .map((path) => {
        try { return absoluteLocalPath(path); } catch { return ""; }
      })
      .filter((path) => !!path && existsSync(path))
      .filter((path) => !protectedRoots.some((protectedPath) => within(protectedPath, path) || within(path, protectedPath)))
      .filter((path) => !within(workspace, path)))];
    writeFileSync(configPath, policyConfig({
      workspace,
      bridgeHome,
      nativeCodexHome,
      userHome: homedir(),
      profileHome: codexHome,
      scratch,
      pathDirectories,
      readPaths: (input.readPaths ?? []).map(absoluteLocalPath),
      writable: input.writable,
      network: input.network,
    }), { encoding: "utf8", flag: "wx", mode: 0o600 });
    securePrivatePath(configPath, false);

    return {
      argv: [cli, "sandbox", "--permission-profile", PROFILE, "--cd", workdir, "--", ...input.command],
      env: commandEnvironment(input.env ?? process.env, codexHome, scratch),
      cleanupRoot,
    };
  } catch (error) {
    cleanupCodexWindowsSandboxPath(cleanupRoot);
    throw error;
  }
}

/** Remove only one random child created directly below our private temp root. */
export function cleanupCodexWindowsSandboxPath(path: string): void {
  try {
    const root = resolve(join(tmpdir(), POLICY_ROOT_NAME));
    const target = resolve(path);
    if (win32.dirname(target).toLowerCase() !== root.toLowerCase() || !/^run-[0-9a-f-]{36}$/i.test(win32.basename(target))) return;
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  } catch { /* cleanup must not replace the command result */ }
}
