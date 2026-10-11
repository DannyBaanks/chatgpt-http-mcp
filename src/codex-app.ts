// Dedicated desktop profile: the native App's user data and provider stay
// untouched. Each launch owns one linked conversation and its private home.
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { buildIsolatedCodexArgs } from "../scripts/install-web-models";
import { LAUNCH_ENV, LAUNCH_HEADER, type LaunchIntent } from "./codex-conversation";

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
export function prepareCodexApp(intent: LaunchIntent, options: {
  port: string; catalogPath: string; appRoot?: string; nativeHome?: string;
  executable?: string; threadId?: string;
}): { executable: string; args: string[]; env: Record<string, string>; home: string } {
  if (intent.client !== "app" || !/^[0-9a-f-]{36}$/.test(intent.launchId)) throw new Error("web_app_intent_invalid");
  if (options.threadId && !/^[\w-]{1,256}$/.test(options.threadId)) throw new Error("web_app_thread_invalid");
  if (process.platform !== "linux") throw new Error("web_app_platform_unsupported: this launcher is verified on Linux");
  const executable = options.executable ?? process.env.ISYMCP_CODEX_APP_BIN ?? "/usr/lib/chatgpt/ChatGPT";
  if (!existsSync(executable)) throw new Error("web_app_binary_missing: set ISYMCP_CODEX_APP_BIN to the desktop executable");
  const root = resolve(options.appRoot ?? join(homedir(), ".isymcp-app"));
  const home = join(root, intent.launchId), codexHome = join(home, "codex"), userData = join(home, "electron");
  if (Buffer.byteLength(join(codexHome, "ipc", "ipc.sock")) > 103) throw new Error("web_app_home_too_long: use a shorter private app root");
  const nativeHome = resolve(options.nativeHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex"));
  if (codexHome === nativeHome || userData === nativeHome) throw new Error("web_app_home_conflict");
  if (!existsSync(options.catalogPath)) throw new Error("web_app_catalog_missing");
  if (!existsSync(join(nativeHome, "auth.json"))) throw new Error("web_app_auth_missing: sign into native Codex first");
  const config = buildIsolatedCodexArgs(`http://127.0.0.1:${options.port}/v1`, intent.model, intent.effort,
    options.catalogPath, undefined, { [LAUNCH_HEADER]: LAUNCH_ENV }).filter((_, i, args) => args[i - 1] === "-c").join("\n") + "\n";
  const markerPath = join(home, "isymcp-profile.json"), configPath = join(codexHome, "config.toml");
  let preferences = "";
  if (existsSync(home)) {
    if (!existsSync(markerPath)) throw new Error("web_app_profile_unowned");
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    if (marker.version !== "isymcp-app/1" || marker.launchId !== intent.launchId || marker.cwd !== intent.cwd || marker.model !== intent.model
      || !existsSync(configPath)) throw new Error("web_app_profile_changed");
    const current = readFileSync(configPath, "utf8");
    const base = marker.baseConfig ?? config; // Legacy markers require the original exact launch settings.
    if (typeof base !== "string" || marker.configHash !== digest(base) || !current.startsWith(base)) throw new Error("web_app_profile_changed");
    try { Bun.TOML.parse(current); } catch { throw new Error("web_app_profile_changed"); }
    // The desktop appends its own plugin/MCP and UI tables on first launch.
    // Preserve those tables; only our unchanged, pinned prefix may be refreshed.
    preferences = current.slice(base.length);
  } else {
    for (const dir of [root, home, codexHome, userData]) { mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700); }
    copyFileSync(join(nativeHome, "auth.json"), join(codexHome, "auth.json"));
    chmodSync(join(codexHome, "auth.json"), 0o600);
    // Seed only this workspace, never copy the user's sidebar or chat state.
    const projectId = intent.launchId;
    writeFileSync(join(codexHome, ".codex-global-state.json"), JSON.stringify({
      "local-projects": { [projectId]: { id: projectId, name: "ISyMCP Web", rootPaths: [intent.cwd], createdAt: Date.now(), updatedAt: Date.now() } },
      "project-order": [projectId], "selected-project": projectId,
    }), { mode: 0o600, flag: "wx" });
  }
  writeFileSync(configPath, config + preferences, { mode: 0o600 }); chmodSync(configPath, 0o600);
  writeFileSync(markerPath, JSON.stringify({ version: "isymcp-app/1", launchId: intent.launchId, cwd: intent.cwd, model: intent.model, configHash: digest(config), baseConfig: config }), { mode: 0o600 });
  const args = [`--user-data-dir=${userData}`];
  if (options.threadId) {
    args.push(`codex://threads/${options.threadId}`);
  }
  return { executable, args, home, env: { CODEX_HOME: codexHome, CODEX_ELECTRON_USER_DATA_PATH: userData, [LAUNCH_ENV]: intent.launchId } };
}

export async function launchCodexApp(plan: ReturnType<typeof prepareCodexApp>): Promise<void> {
  const env = { ...process.env, ...plan.env };
  delete env.OPENAI_BASE_URL; delete env.OPENAI_API_BASE; delete env.CODEX_API_BASE_URL;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(plan.executable, plan.args, { detached: true, stdio: "ignore", env });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}
