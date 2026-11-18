// src/handoff/service.ts — Carga unificada de handoffs NVAPI del Baúl + verificación viva con ziggrep.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, watch } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface VaultHandoffEntry {
  conv_id: string;
  short_id: string;
  title: string;
  workspace: string;
  model: string;
  reduction: string;
  path: string;
  mtime_ms: number;
  size_bytes: number;
}

export interface ReferencedFileStatus {
  path: string;
  exists: boolean;
  size_bytes?: number;
}

export interface HandoffLoadResult {
  ok: boolean;
  conv_id?: string;
  short_id?: string;
  title?: string;
  workspace?: string;
  model?: string;
  reduction?: string;
  handoff_file?: string;
  handoff_markdown?: string;
  referenced_files?: ReferencedFileStatus[];
  ziggrep_tool?: string;
  ziggrep_terms?: string[];
  ziggrep_matches?: string;
  git_status?: string;
  git_recent_commits?: string;
  vault_count?: number;
  error?: string;
}

export function resolveRealHome(): string {
  const envHome = process.env.HOME || homedir();
  const marker = "/.gemini/antigravity-cli/accounts/";
  const idx = envHome.indexOf(marker);
  if (idx > 0) {
    return envHome.slice(0, idx);
  }
  return envHome;
}

export function resolveCompactedDir(customDir?: string): string {
  if (customDir && customDir.trim()) return resolve(customDir.trim());
  const envDir = process.env.ISYMCP_COMPACTED_DIR?.trim();
  if (envDir) return resolve(envDir);
  const agyData = process.env.AGY_DATA_DIR?.trim();
  if (agyData) return join(resolve(agyData), "compacted");
  return join(resolveRealHome(), ".gemini", "antigravity-cli", "compacted");
}

export function parseHandoffHeader(filePath: string): VaultHandoffEntry {
  const base = filePath.split("/").pop() ?? filePath;
  let convId = base.replace(/_handoff\.md$/, "");
  let title = convId;
  let workspace = "";
  let model = "";
  let reduction = "";
  let mtimeMs = 0;
  let sizeBytes = 0;
  let head = "";
  try {
    const st = statSync(filePath);
    mtimeMs = st.mtimeMs;
    sizeBytes = st.size;
    head = readFileSync(filePath, "utf8").slice(0, 3072);
  } catch {
    // ignore read/stat errors
  }

  for (const line of head.split(/\r?\n/)) {
    if (line.startsWith("# ") && line.includes("(`")) {
      const m = line.match(/\(`([^`]+)`\)/);
      if (m?.[1]) model = m[1];
    } else if (line.includes("**Conversación original:**")) {
      const m = line.match(/`([^`]+)`\s*\(([^)]*)\)/);
      if (m) {
        if (m[1]?.trim()) convId = m[1].trim();
        if (m[2]?.trim()) title = m[2].trim();
      }
    } else if (line.includes("**Workspace:**")) {
      const m = line.match(/`([^`]+)`/);
      if (m?.[1]?.trim()) workspace = m[1].trim();
    } else if (line.includes("**Reducción de contexto:**")) {
      const idx = line.indexOf(":");
      if (idx >= 0) {
        reduction = line.slice(idx + 1).replace(/[`*]/g, "").trim();
      }
    }
  }

  return {
    conv_id: convId,
    short_id: convId.slice(0, 8),
    title,
    workspace,
    model,
    reduction,
    path: filePath,
    mtime_ms: mtimeMs,
    size_bytes: sizeBytes,
  };
}

export function listCompactedVault(customDir?: string): VaultHandoffEntry[] {
  const dir = resolveCompactedDir(customDir);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((name) => name.endsWith("_handoff.md"))
    .map((name) => parseHandoffHeader(join(dir, name)));
  files.sort((a, b) => b.mtime_ms - a.mtime_ms);
  return files;
}

const STOP_SYMBOLS = new Set([
  "README", "AGENTS", "GUIA", "SKILL", "Markdown", "JSON", "Python", "TypeScript",
  "NVIDIA", "Nemotron", "Ultra", "RUNNING", "IDLE", "HIBERNATED", "SAVED",
  "OBJETIVO", "TRABAJO", "ARCHIVOS", "ESTADO", "SIGUIENTE", "PASO",
  "tool_calls", "USER_INPUT", "PLANNER_RESPONSE", "systemMessage", "created_at", "step_index",
  "input_tokens", "cache_read_tokens", "output_tokens",
]);

export function extractSymbolsAndPaths(markdown: string, workspace: string): {
  paths: string[];
  symbols: string[];
} {
  const pathsSet = new Set<string>();
  const symbolsSet = new Set<string>();

  const codeMatches = markdown.matchAll(/`([^`\n]{2,140})`/g);
  for (const m of codeMatches) {
    const token = m[1].trim();
    if (!token || token.includes(" ") && !token.includes("/")) continue;
    if (
      (token.includes("/") || /\.(py|ts|tsx|js|zig|md|json|toml|sh|swift|rs)$/i.test(token)) &&
      !token.startsWith("http") &&
      !token.includes("*")
    ) {
      pathsSet.add(token);
      continue;
    }
    if (
      /^[A-Za-z_][A-Za-z0-9_]{3,48}(?:\(\))?$/.test(token) &&
      !STOP_SYMBOLS.has(token) &&
      (token.includes("_") || /[a-z][A-Z]/.test(token))
    ) {
      symbolsSet.add(token.replace(/\(\)$/, ""));
    }
  }

  const paths = [...pathsSet].slice(0, 12);
  const symbols = [...symbolsSet].slice(0, 8);
  // Ensure relative checks stay well-formed
  void workspace;
  return { paths, symbols };
}

function resolveFileStatus(rawPath: string, workspace: string): ReferencedFileStatus {
  const candidate = isAbsolute(rawPath) ? rawPath : (workspace ? join(workspace, rawPath) : rawPath);
  if (existsSync(candidate)) {
    try {
      const st = statSync(candidate);
      if (st.isFile() || st.isDirectory()) {
        return { path: rawPath, exists: true, size_bytes: st.isFile() ? st.size : undefined };
      }
    } catch {
      // fall through
    }
  }
  return { path: rawPath, exists: false };
}

function findBinary(name: string, extraPaths: string[] = []): string | null {
  for (const p of extraPaths) {
    if (existsSync(p)) return p;
  }
  const w = spawnSync("which", [name], { encoding: "utf8" });
  if (w.status === 0) {
    const found = String(w.stdout || "").trim().split(/\r?\n/)[0];
    if (found) return found;
  }
  return null;
}

function runZiggrep(terms: string[], searchRoot: string, maxLines = 45): { tool: string; output: string } {
  if (!terms.length || !searchRoot || !existsSync(searchRoot)) {
    return { tool: "none", output: "" };
  }
  const realHome = resolveRealHome();
  const zigBin = findBinary("ziggrep", [join(realHome, ".local", "bin", "ziggrep")]);
  const rgBin = zigBin ? null : findBinary("rg");
  const tool = zigBin ? "ziggrep" : (rgBin ? "rg" : "grep");
  const cmd = zigBin ?? rgBin ?? "grep";

  const args: string[] = tool === "grep"
    ? ["-rn", "-F", "--exclude=*.json", "--exclude=*.jsonl"]
    : (tool === "ziggrep"
      ? ["-n", "-F", "--exclude=*.json", "--exclude=*.jsonl"]
      : ["-n", "-F", "-g", "!*.json", "-g", "!*.jsonl"]);
  for (const t of terms) args.push("-e", t);
  args.push(searchRoot);

  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    timeout: 6000,
    maxBuffer: 512 * 1024,
  });
  const raw = String(res.stdout || "").trim();
  if (!raw) return { tool, output: "" };
  const lines = raw.split(/\r?\n/).slice(0, maxLines).map((l) => (l.length > 200 ? `${l.slice(0, 200)}…` : l));
  const totalLines = raw.split(/\r?\n/).length;
  const clipped = lines.join("\n");
  const suffix = totalLines > maxLines ? `\n... (+${totalLines - maxLines} coincidencias más)` : "";
  return { tool, output: clipped + suffix };
}

function runGitSnapshot(workspace: string): { status: string; commits: string } {
  if (!workspace || !existsSync(workspace)) return { status: "", commits: "" };
  const st = spawnSync("git", ["-C", workspace, "status", "--short", "-uno"], { encoding: "utf8", timeout: 5000 });
  if (st.status !== 0) return { status: "", commits: "" };
  const lg = spawnSync("git", ["-C", workspace, "log", "-n", "5", "--oneline"], { encoding: "utf8", timeout: 5000 });
  return {
    status: String(st.stdout || "").trim().split(/\r?\n/).slice(0, 25).join("\n"),
    commits: lg.status === 0 ? String(lg.stdout || "").trim() : "",
  };
}

export async function loadAgyHandoffContext(opts: {
  target?: string;
  workspace?: string;
  query?: string;
  max_matches?: number;
  compacted_dir?: string;
} = {}): Promise<HandoffLoadResult> {
  const entries = listCompactedVault(opts.compacted_dir);
  if (entries.length === 0) {
    return {
      ok: false,
      vault_count: 0,
      error: `No hay handoffs compactados en el Baúl (${resolveCompactedDir(opts.compacted_dir)}).`,
    };
  }

  const target = (opts.target ?? "").trim();
  const reqWs = (opts.workspace ?? "").trim();
  let chosen: VaultHandoffEntry | undefined;

  if (target) {
    const low = target.toLowerCase();
    chosen =
      entries.find((e) => e.conv_id.toLowerCase() === low || e.short_id.toLowerCase() === low) ??
      entries.find((e) => e.conv_id.toLowerCase().startsWith(low)) ??
      entries.find((e) => e.title.toLowerCase().includes(low));
    if (!chosen) {
      return {
        ok: false,
        vault_count: entries.length,
        error: `No se encontró handoff en el Baúl para '${target}'. Disponibles: ${entries.slice(0, 6).map((e) => `${e.short_id}(${e.title})`).join(", ")}`,
      };
    }
  } else if (reqWs) {
    chosen = entries.find((e) => e.workspace === reqWs) ?? entries[0];
  } else {
    chosen = entries[0];
  }

  const markdown = readFileSync(chosen.path, "utf8");
  const ws = reqWs || chosen.workspace || process.cwd();
  const { paths, symbols } = extractSymbolsAndPaths(markdown, ws);
  const customTerms = (opts.query ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
  const terms = [...new Set([...customTerms, ...symbols])].slice(0, 10);

  const referencedFiles = paths.map((p) => resolveFileStatus(p, ws));
  const maxMatches = typeof opts.max_matches === "number" && opts.max_matches > 0 ? Math.min(120, opts.max_matches) : 45;
  const zg = runZiggrep(terms, ws, maxMatches);
  const gitSnap = runGitSnapshot(ws);

  return {
    ok: true,
    conv_id: chosen.conv_id,
    short_id: chosen.short_id,
    title: chosen.title,
    workspace: ws,
    model: chosen.model,
    reduction: chosen.reduction,
    handoff_file: chosen.path,
    handoff_markdown: markdown,
    referenced_files: referencedFiles,
    ziggrep_tool: zg.tool,
    ziggrep_terms: terms,
    ziggrep_matches: zg.output,
    git_status: gitSnap.status,
    git_recent_commits: gitSnap.commits,
    vault_count: entries.length,
  };
}

export async function triggerNvapiCompaction(opts: {
  target?: string;
  open?: boolean;
  background?: boolean;
} = {}): Promise<{ ok: boolean; target: string; open: boolean; background: boolean; output?: string; error?: string }> {
  const target = (opts.target ?? "self").trim() || "self";
  const open = opts.open !== false;
  const background = opts.background !== false;
  const realHome = resolveRealHome();
  const dashBin = findBinary("agy-dash", [join(realHome, ".local", "bin", "agy-dash")]) ?? "agy-dash";
  const args = ["compact", target];
  if (open) args.push("--open");
  if (background) args.push("--bg");

  if (background) {
    const child = spawn(dashBin, args, { detached: true, stdio: "ignore" });
    child.unref();
    return {
      ok: true,
      target,
      open,
      background: true,
      output: `Compactación NVIDIA Nemotron lanzada en 2º plano para '${target}'${open ? " (abrirá la nueva sesión ligera al terminar)" : " (se guardará en el Baúl NV)"}.`,
    };
  }

  const res = spawnSync(dashBin, args, { encoding: "utf8", timeout: 120_000 });
  if (res.status !== 0) {
    return {
      ok: false,
      target,
      open,
      background: false,
      error: String(res.stderr || res.stdout || `exit ${res.status}`).trim(),
    };
  }
  return {
    ok: true,
    target,
    open,
    background: false,
    output: String(res.stdout || "").trim(),
  };
}

export async function waitForHandoffDelivery(opts: {
  short_id: string;
  compacted_dir?: string;
  since_ms?: number;
  timeout_ms?: number;
}): Promise<{ ok: boolean; status: string; handoff_file?: string; message?: string; error?: string }> {
  const dir = resolveCompactedDir(opts.compacted_dir);
  mkdirSync(dir, { recursive: true });
  const shortId = opts.short_id.slice(0, 8);
  const handoffPath = join(dir, `${shortId}_handoff.md`);
  const statusPath = join(dir, `.status_${shortId}.json`);
  const sinceMs = opts.since_ms ?? (Date.now() - 500);
  const timeoutMs = Math.max(500, Math.min(180_000, opts.timeout_ms ?? 120_000));
  const deadline = Date.now() + timeoutMs;

  const checkReady = (): { done: boolean; ok: boolean; status: string; message?: string } | null => {
    if (existsSync(statusPath)) {
      try {
        const st = JSON.parse(readFileSync(statusPath, "utf8")) as {
          status?: string;
          message?: string;
          updated_at?: number;
        };
        const stUpdatedMs = typeof st.updated_at === "number" ? st.updated_at * 1000 : 0;
        if (st.status === "error" && stUpdatedMs >= sinceMs - 1000) {
          return { done: true, ok: false, status: "error", message: st.message || "Error en compactación NVAPI" };
        }
        if (st.status === "done" && existsSync(handoffPath)) {
          const fst = statSync(handoffPath);
          if (fst.size > 0 && fst.mtimeMs >= sinceMs - 1000) {
            return { done: true, ok: true, status: "done", message: st.message };
          }
        }
      } catch {
        // ignore partial writes
      }
    }
    if (existsSync(handoffPath)) {
      try {
        const fst = statSync(handoffPath);
        if (fst.size > 0 && fst.mtimeMs >= sinceMs) {
          return { done: true, ok: true, status: "done", message: "Handoff entregado por Nemotron." };
        }
      } catch {
        // ignore
      }
    }
    return null;
  };

  const immediate = checkReady();
  if (immediate) {
    return immediate.ok
      ? { ok: true, status: immediate.status, handoff_file: handoffPath, message: immediate.message }
      : { ok: false, status: immediate.status, error: immediate.message };
  }

  return await new Promise((resolveDone) => {
    let settled = false;
    let watcher: ReturnType<typeof watch> | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;

    const finish = (res: { ok: boolean; status: string; handoff_file?: string; message?: string; error?: string }) => {
      if (settled) return;
      settled = true;
      try { watcher?.close(); } catch { /* ignore */ }
      if (timer) clearInterval(timer);
      resolveDone(res);
    };

    const probe = () => {
      const hit = checkReady();
      if (hit) {
        finish(
          hit.ok
            ? { ok: true, status: hit.status, handoff_file: handoffPath, message: hit.message }
            : { ok: false, status: hit.status, error: hit.message },
        );
        return;
      }
      if (Date.now() >= deadline) {
        finish({
          ok: false,
          status: "timeout",
          error: `Timeout (${Math.round(timeoutMs / 1000)}s) esperando handoff '${shortId}_handoff.md' en ${dir}.`,
        });
      }
    };

    try {
      watcher = watch(dir, () => probe());
    } catch {
      // fall back to polling only
    }
    timer = setInterval(probe, 250);
  });
}

export async function triggerSelfCompact(opts: {
  conv_id?: string;
  cwd?: string;
  resume_prompt?: string;
  model?: string;
  in_place?: boolean;
  wait?: boolean;
  wait_timeout_ms?: number;
  compacted_dir?: string;
  dryRun?: boolean;
} = {}): Promise<{
  ok: boolean;
  conv_id: string;
  in_place: boolean;
  model: string;
  command?: string[];
  handoff_file?: string;
  handoff_context?: HandoffLoadResult;
  message?: string;
  error?: string;
}> {
  const convId = (opts.conv_id ?? "self").trim() || "self";
  const inPlace = opts.in_place !== false;
  const shouldWait = opts.wait !== false;
  const model = (opts.model ?? "nvidia/nemotron-3-ultra-550b-a55b").trim();
  const realHome = resolveRealHome();
  const dashBin =
    findBinary("agy-dash", [join(realHome, ".local", "bin", "agy-dash")]) ?? "agy-dash";

  const args = ["self-compact", convId, "--bg"];
  if (shouldWait) args.push("--no-respawn");
  if (opts.cwd?.trim()) args.push("--cwd", opts.cwd.trim());
  if (opts.resume_prompt?.trim()) args.push("--resume-prompt", opts.resume_prompt.trim());
  if (model) args.push("--model", model);
  if (!inPlace) args.push("--no-in-place");

  if (opts.dryRun) {
    return {
      ok: true,
      conv_id: convId,
      in_place: inPlace,
      model,
      command: [dashBin, ...args],
      message: "Dry-run de auto-compactación con Nemotron 550B (con monitor de entrega).",
    };
  }

  const startedMs = Date.now();
  const launch = spawnSync(dashBin, args, { encoding: "utf8", timeout: 10_000 });
  if (launch.status !== 0) {
    return {
      ok: false,
      conv_id: convId,
      in_place: inPlace,
      model,
      error: String(launch.stderr || launch.stdout || `agy-dash exit ${launch.status}`).trim(),
    };
  }

  let resolvedConvId = convId;
  try {
    const parsed = JSON.parse(String(launch.stdout || "{}")) as { conv_id?: string };
    if (parsed.conv_id) resolvedConvId = parsed.conv_id;
  } catch {
    // ignore
  }

  if (!shouldWait) {
    return {
      ok: true,
      conv_id: resolvedConvId,
      in_place: inPlace,
      model,
      message: `⏳ Auto-compactación con ${model} lanzada en 2º plano para '${resolvedConvId}'.`,
    };
  }

  // Wait reactively until Nemotron writes <short_id>_handoff.md (wakes the agent automatically)
  const delivery = await waitForHandoffDelivery({
    short_id: resolvedConvId,
    compacted_dir: opts.compacted_dir,
    since_ms: startedMs,
    timeout_ms: opts.wait_timeout_ms ?? 120_000,
  });
  if (!delivery.ok) {
    return {
      ok: false,
      conv_id: resolvedConvId,
      in_place: inPlace,
      model,
      error: delivery.error || "Falló la entrega del handoff por Nemotron.",
    };
  }

  const ctx = await loadAgyHandoffContext({
    target: resolvedConvId.slice(0, 8),
    workspace: opts.cwd,
    compacted_dir: opts.compacted_dir,
  });

  if (inPlace) {
    // Schedule instant in-place tmux respawn from existing vault handoff 1.5s after returning
    const respawnCmd = [
      "bash",
      "-c",
      `sleep 1.5 && ${JSON.stringify(dashBin)} self-compact ${JSON.stringify(resolvedConvId)} --respawn-only --cwd ${JSON.stringify(opts.cwd || process.cwd())}${opts.resume_prompt ? ` --resume-prompt ${JSON.stringify(opts.resume_prompt)}` : ""}`,
    ];
    const rchild = spawn(respawnCmd[0], respawnCmd.slice(1), { detached: true, stdio: "ignore" });
    rchild.unref();
  }

  return {
    ok: true,
    conv_id: resolvedConvId,
    in_place: inPlace,
    model,
    handoff_file: delivery.handoff_file,
    handoff_context: ctx,
    message: delivery.message || `✅ Handoff entregado por ${model} y cargado vía ziggrep.`,
  };
}
