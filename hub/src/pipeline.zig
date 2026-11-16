//! agentspipeline — Orquestación dinámica multi-agente en worktrees aislados.
//!
//! Expuesto como tool nativa de `isymcp-hub` (`agentspipeline`) y como
//! subcomando CLI (`isymcp-hub agentspipeline`).
//!
//! Invariantes obligatorias:
//!   1. Cada trabajador mantiene su propio alcance y permisos (sin herencia
//!      automática de privilegios ni flags `--dangerously-*` por defecto).
//!   2. El orquestador conserva un `run_id` persistente en disco, grafo de
//!      dependencias (`depends_on`) y recibos por trabajador.
//!   3. Los worktrees aíslan cambios, pero NUNCA sustituyen la autorización
//!      explícita para integrarlos (`integration_authorized=true`).
//!   4. Si el agente principal desaparece, los trabajos terminados quedan
//!      registrados y los pendientes pueden recuperarse (`status` / `resume`).
//!   5. Nunca se ejecutan comandos destructivos solamente porque el planificador
//!      los solicitó.

const std = @import("std");
const sys = @import("sys.zig");

const Writer = std.Io.Writer;

pub const CLI_HELP =
    \\isymcp-hub agentspipeline — Pipeline dinámico multi-agente con invariantes de seguridad
    \\
    \\Uso MCP (en isymcp-hub):
    \\  agentspipeline(action="discover")
    \\  agentspipeline(action="plan", repo_root="...", base_ref="HEAD", wave_name="w11", tasks=[...])
    \\  agentspipeline(action="receipt", run_id="...", task_id="...", status="completed", commit_sha="...", exit_code=0)
    \\  agentspipeline(action="status", run_id="...")
    \\  agentspipeline(action="resume", run_id="...")
    \\  agentspipeline(action="verify", run_id="...", integration_authorized=true, verify_cmds=[...])
    \\
    \\Uso CLI:
    \\  isymcp-hub agentspipeline [--discover]
    \\  isymcp-hub agentspipeline status <run_id>
    \\
;

const DetectedAgent = struct {
    id: []const u8,
    cli: []const u8,
    available: bool,
    path: ?[]const u8,
    recommended_models: []const []const u8,
    best_for: []const u8,
};

fn findCli(a: std.mem.Allocator, env: *const std.process.Environ.Map, bin: []const u8) ?[]const u8 {
    if (env.get("HOME")) |home| {
        const extra = [_]?[]const u8{
            tryPrint(a, "{s}/.local/bin/{s}", .{ home, bin }),
            tryPrint(a, "{s}/.opencode/bin/{s}", .{ home, bin }),
            tryPrint(a, "{s}/.bun/bin/{s}", .{ home, bin }),
        };
        for (extra) |maybe_p| {
            if (maybe_p) |p| if (sys.exists(p)) return p;
        }
    }
    if (env.get("PATH")) |path_env| {
        var it = std.mem.splitScalar(u8, path_env, ':');
        while (it.next()) |dir| {
            if (dir.len == 0) continue;
            if (tryPrint(a, "{s}/{s}", .{ dir, bin })) |cand| {
                if (sys.exists(cand)) return cand;
            }
        }
    }
    return null;
}

fn tryPrint(a: std.mem.Allocator, comptime fmt: []const u8, args: anytype) ?[]const u8 {
    return std.fmt.allocPrint(a, fmt, args) catch null;
}

fn jsonStr(w: anytype, s: []const u8) !void {
    try w.writeByte('"');
    for (s) |c| {
        switch (c) {
            '"' => try w.writeAll("\\\""),
            '\\' => try w.writeAll("\\\\"),
            '\n' => try w.writeAll("\\n"),
            '\r' => try w.writeAll("\\r"),
            '\t' => try w.writeAll("\\t"),
            else => {
                if (c < 0x20) {
                    try w.print("\\u{x:0>4}", .{c});
                } else {
                    try w.writeByte(c);
                }
            },
        }
    }
    try w.writeByte('"');
}

fn repoSlug(repo_root: []const u8) []const u8 {
    const trimmed = std.mem.trimEnd(u8, repo_root, "/");
    if (std.mem.lastIndexOfScalar(u8, trimmed, '/')) |idx| {
        const base = trimmed[idx + 1 ..];
        return if (base.len > 0) base else "repo";
    }
    return if (trimmed.len > 0) trimmed else "repo";
}

fn sanitizeId(a: std.mem.Allocator, raw: []const u8) ![]const u8 {
    var out: std.ArrayList(u8) = .empty;
    for (raw) |c| {
        if ((c >= 'a' and c <= 'z') or (c >= 'A' and c <= 'Z') or (c >= '0' and c <= '9') or c == '_' or c == '-') {
            try out.append(a, c);
        } else {
            try out.append(a, '_');
        }
    }
    if (out.items.len == 0) try out.appendSlice(a, "task");
    return out.items;
}

fn strField(obj: std.json.ObjectMap, k: []const u8) ?[]const u8 {
    const v = obj.get(k) orelse return null;
    return if (v == .string and v.string.len > 0) v.string else null;
}

fn boolField(obj: std.json.ObjectMap, k: []const u8, default_val: bool) bool {
    const v = obj.get(k) orelse return default_val;
    return if (v == .bool) v.bool else default_val;
}

fn intField(obj: std.json.ObjectMap, k: []const u8, default_val: i64) i64 {
    const v = obj.get(k) orelse return default_val;
    return if (v == .integer) v.integer else default_val;
}

pub fn containsDestructivePattern(text: []const u8) ?[]const u8 {
    const patterns = [_][]const u8{
        "rm -rf",
        "rm -fr",
        "rm -r ",
        "git reset --hard",
        "git clean -f",
        "git clean -fd",
        "git clean -x",
        "worktree remove --force",
        "git worktree prune",
        "mkfs.",
        "dd if=",
    };
    for (patterns) |pat| {
        if (std.ascii.indexOfIgnoreCase(text, pat) != null) return pat;
    }
    return null;
}

fn runsDir(a: std.mem.Allocator, env: *const std.process.Environ.Map) ![]const u8 {
    if (env.get("ISYMCP_PIPELINE_DIR")) |dir| {
        if (dir.len > 0) {
            try sys.ensurePrivateDir(dir);
            return dir;
        }
    }
    const home = env.get("HOME") orelse "/tmp";
    const dir = try std.fmt.allocPrint(a, "{s}/.codex-web-http/hub/runs", .{home});
    try sys.ensurePrivateDir(dir);
    return dir;
}

fn runFilePath(a: std.mem.Allocator, env: *const std.process.Environ.Map, raw_run_id: []const u8) ![]const u8 {
    const dir = try runsDir(a, env);
    const rid = try sanitizeId(a, raw_run_id);
    return try std.fmt.allocPrint(a, "{s}/{s}.json", .{ dir, rid });
}

fn writeJsonStrArray(ww: anytype, items: []const []const u8) !void {
    try ww.writeByte('[');
    for (items, 0..) |it, i| {
        if (i > 0) try ww.writeByte(',');
        try jsonStr(ww, it);
    }
    try ww.writeByte(']');
}

fn readStringArray(a: std.mem.Allocator, obj: std.json.ObjectMap, key: []const u8) ![]const []const u8 {
    const val = obj.get(key) orelse return &.{};
    if (val != .array) return &.{};
    var out: std.ArrayList([]const u8) = .empty;
    for (val.array.items) |item| {
        if (item == .string and item.string.len > 0) {
            try out.append(a, item.string);
        }
    }
    return out.items;
}

pub fn runDiscoverJson(a: std.mem.Allocator, env: *const std.process.Environ.Map) ![]u8 {
    const claude_models = [_][]const u8{ "haiku", "sonnet", "opus" };
    const codex_models = [_][]const u8{"gpt-6-luna"};
    const openisy_models = [_][]const u8{
        "nvidia/minimaxai/minimax-m3.1-flash",
        "nvidia/stepfun-ai/step-5-preview",
        "nvidia/nvidia/nemotron-3.5-super-vl-120b-a12b",
        "xkiro/mistralai/mistral-large-4-0",
        "freellmapi/glm-5.3",
    };
    const agy_models = [_][]const u8{"subagent / native swarm"};

    const detected = [_]DetectedAgent{
        .{
            .id = "claude",
            .cli = "claude",
            .available = findCli(a, env, "claude") != null,
            .path = findCli(a, env, "claude"),
            .recommended_models = &claude_models,
            .best_for = "Debugging profundo, suites de regresion, refactoring limpio (sonnet/haiku)",
        },
        .{
            .id = "codex",
            .cli = "codex",
            .available = findCli(a, env, "codex") != null,
            .path = findCli(a, env, "codex"),
            .recommended_models = &codex_models,
            .best_for = "Motores complejos, C/assembly/IR, fuzzers diferenciales y Tier A (gpt-6-luna)",
        },
        .{
            .id = "openisy",
            .cli = "openisy",
            .available = findCli(a, env, "openisy") != null,
            .path = findCli(a, env, "openisy"),
            .recommended_models = &openisy_models,
            .best_for = "Orquestacion ligera y exploracion multi-provider (minimax/step/nemotron/mistral)",
        },
        .{
            .id = "agy",
            .cli = "agy",
            .available = findCli(a, env, "agy") != null,
            .path = findCli(a, env, "agy"),
            .recommended_models = &agy_models,
            .best_for = "Subagentes nativos dentro de la misma sesion cuando no se requiera CLI externo",
        },
    };

    var w: Writer.Allocating = .init(a);
    const ww = &w.writer;
    try ww.writeAll("{\"pipeline\":\"isymcp-hub-agentspipeline\",\"version\":\"2.0.0\",\"fixed_agent_count\":false,");
    try ww.writeAll("\"detected_agents\":[");
    for (detected, 0..) |ag, i| {
        if (i > 0) try ww.writeAll(",");
        try ww.writeAll("{\"id\":");
        try jsonStr(ww, ag.id);
        try ww.writeAll(",\"cli\":");
        try jsonStr(ww, ag.cli);
        try ww.print(",\"available\":{s},\"path\":", .{if (ag.available) "true" else "false"});
        if (ag.path) |p| try jsonStr(ww, p) else try ww.writeAll("null");
        try ww.writeAll(",\"recommended_models\":[");
        for (ag.recommended_models, 0..) |m, mi| {
            if (mi > 0) try ww.writeAll(",");
            try jsonStr(ww, m);
        }
        try ww.writeAll("],\"best_for\":");
        try jsonStr(ww, ag.best_for);
        try ww.writeAll("}");
    }
    try ww.writeAll("],");
    try ww.writeAll("\"interactive_intake_questions\":[");
    try ww.writeAll("{\"id\":\"tasks_scope\",\"question\":\"¿Cuantas tareas independientes quieres correr en esta ola (N dinamico, sin numero fijo) y cual es el alcance (allowed_paths / dependencias) de cada una?\"},");
    try ww.writeAll("{\"id\":\"agent_assignment\",\"question\":\"¿Que agente/modelo quieres asignar a cada tarea, o prefieres auto-reparto inteligente segun complejidad (haiku/sonnet/codex/openisy)?\"},");
    try ww.writeAll("{\"id\":\"isolation_mode\",\"question\":\"¿Aislamos cada tarea en su propio git worktree (/var/tmp/<repo>_wt_<ola>_<id>) con recibos persistentes y compuerta explicita de integracion? (Recomendado)\"}");
    try ww.writeAll("],");
    try ww.writeAll("\"auto_routing_rules\":{");
    try ww.writeAll("\"dynamic_sizing\":\"Crea exactamente 1 worktree y 1 worker por cada tarea independiente (N=1..N, nunca fijes un numero fijo).\",");
    try ww.writeAll("\"complex_codegen_or_fuzzer\":\"codex (gpt-6-luna) o claude --model sonnet\",");
    try ww.writeAll("\"focused_fix_or_tests\":\"claude --model haiku\",");
    try ww.writeAll("\"multi_provider_or_orchestration\":\"openisy run -m <provider/model> (si el socket falla, hacer fallback a claude/codex)\",");
    try ww.writeAll("\"invariants\":[");
    try jsonStr(ww, "Cada trabajador mantiene su propio alcance (allowed_paths, read_only, permission_mode) y NO hereda privilegios ilimitados.");
    try ww.writeAll(",");
    try jsonStr(ww, "El orquestador conserva un run_id persistente en disco, grafo depends_on y recibos por trabajador.");
    try ww.writeAll(",");
    try jsonStr(ww, "Los worktrees aislan cambios pero NO autorizan integracion; integrar requiere revision y integration_authorized=true.");
    try ww.writeAll(",");
    try jsonStr(ww, "Si el agente principal desaparece, status/resume recuperan trabajos terminados y pendientes por run_id.");
    try ww.writeAll(",");
    try jsonStr(ww, "Nunca se ejecutan comandos destructivos solamente porque el planificador los solicito.");
    try ww.writeAll(",");
    try jsonStr(ww, "Nunca usar pkill -f contra un MCP (mata todas las sesiones).");
    try ww.writeAll("]},\"next\":\"Pregunta al usuario usando interactive_intake_questions (o auto-reparte si ya dio las tareas) y luego llama agentspipeline(action=\\\"plan\\\", repo_root=..., base_ref=..., wave_name=..., tasks=[...]).\"}");
    return w.written();
}

pub fn runPlanJson(a: std.mem.Allocator, env: *const std.process.Environ.Map, args: std.json.ObjectMap) ![]u8 {
    const repo_root = strField(args, "repo_root") orelse ".";
    const base_ref = strField(args, "base_ref") orelse "HEAD";
    const wave_name = try sanitizeId(a, strField(args, "wave_name") orelse "wave");
    const slug = try sanitizeId(a, repoSlug(repo_root));
    const destructive_approved = boolField(args, "destructive_approved", false);

    const now_ms = sys.realtimeMs();
    const run_id = if (strField(args, "run_id")) |rid|
        try sanitizeId(a, rid)
    else
        try std.fmt.allocPrint(a, "{s}_{d}", .{ wave_name, now_ms });

    const tasks_val = args.get("tasks") orelse return error.MissingTasks;
    if (tasks_val != .array or tasks_val.array.items.len == 0) return error.MissingTasks;

    var ledger: Writer.Allocating = .init(a);
    const lw = &ledger.writer;
    try lw.writeAll("{\"run_id\":");
    try jsonStr(lw, run_id);
    try lw.writeAll(",\"repo_root\":");
    try jsonStr(lw, repo_root);
    try lw.writeAll(",\"base_ref\":");
    try jsonStr(lw, base_ref);
    try lw.writeAll(",\"wave_name\":");
    try jsonStr(lw, wave_name);
    try lw.print(",\"created_at_ms\":{d},\"updated_at_ms\":{d}", .{ now_ms, now_ms });
    try lw.print(",\"task_count\":{d},\"tasks\":[", .{tasks_val.array.items.len});

    for (tasks_val.array.items, 0..) |item, idx| {
        if (item != .object) return error.InvalidTask;
        const obj = item.object;
        const raw_id = strField(obj, "id") orelse try std.fmt.allocPrint(a, "t{d}", .{idx + 1});
        const tid = try sanitizeId(a, raw_id);
        const title = strField(obj, "title") orelse tid;
        const raw_prompt = strField(obj, "prompt") orelse title;
        const agent = strField(obj, "agent") orelse "claude";
        const model = strField(obj, "model");
        const verify_cmd = strField(obj, "verify_cmd") orelse "pytest -q";
        const read_only = boolField(obj, "read_only", false);
        const depends_on = try readStringArray(a, obj, "depends_on");
        const allowed_paths = try readStringArray(a, obj, "allowed_paths");

        if (!destructive_approved) {
            if (containsDestructivePattern(raw_prompt) != null or containsDestructivePattern(verify_cmd) != null) {
                return error.DestructiveCommandBlocked;
            }
        }
        for (depends_on) |dep| {
            const dep_id = try sanitizeId(a, dep);
            if (std.mem.eql(u8, dep_id, tid)) return error.SelfDependency;
        }

        const effective_perm = strField(obj, "permission_mode") orelse (if (read_only)
            (if (std.mem.eql(u8, agent, "codex")) "read-only" else "plan")
        else
            (if (std.mem.eql(u8, agent, "codex")) "workspace-write" else "acceptEdits"));

        const scope_str = if (allowed_paths.len > 0)
            try std.mem.join(a, ", ", allowed_paths)
        else
            ".";

        const wt_dir = try std.fmt.allocPrint(a, "/var/tmp/{s}_wt_{s}_{s}", .{ slug, wave_name, tid });
        const wt_cmd = try std.fmt.allocPrint(a, "git -C \"{s}\" worktree add --detach \"{s}\" {s}", .{ repo_root, wt_dir, base_ref });

        const worker_prompt = try std.fmt.allocPrint(
            a,
            "Run {s} | Task {s} ({s}) in isolated worktree {s}. Scope allowed_paths=[{s}] read_only={s}. Task: {s}. Verify with: {s}. Invariants: stay strictly inside your allowed_paths; do NOT run destructive commands or delete worktrees/untracked files; commit only your own files with 'git commit -- <files>'; do NOT merge/cherry-pick into main branch; report exact commit_sha and observed test output.",
            .{ run_id, tid, title, wt_dir, scope_str, if (read_only) "true" else "false", raw_prompt, verify_cmd },
        );

        const effective_model = model orelse (if (std.mem.eql(u8, agent, "codex"))
            "gpt-6-luna"
        else if (std.mem.eql(u8, agent, "openisy"))
            "nvidia/minimaxai/minimax-m3.1-flash"
        else
            "haiku");

        const launch_cmd = if (std.mem.eql(u8, agent, "codex"))
            try std.fmt.allocPrint(a, "cd \"{s}\" && codex exec -s {s} << 'EOF'\n{s}\nEOF", .{ wt_dir, effective_perm, worker_prompt })
        else if (std.mem.eql(u8, agent, "openisy"))
            try std.fmt.allocPrint(a, "cd \"{s}\" && openisy run -m {s} << 'EOF'\n{s}\nEOF", .{ wt_dir, effective_model, worker_prompt })
        else if (std.mem.eql(u8, agent, "subagent"))
            try std.fmt.allocPrint(a, "invoke_subagent / swarm(workspace='share', model={s}) -> {s}", .{ model orelse "inherit", worker_prompt })
        else
            try std.fmt.allocPrint(a, "cd \"{s}\" && claude -p --permission-mode {s} --model {s} << 'EOF'\n{s}\nEOF", .{ wt_dir, effective_perm, effective_model, worker_prompt });

        if (idx > 0) try lw.writeByte(',');
        try lw.writeAll("{\"id\":");
        try jsonStr(lw, tid);
        try lw.writeAll(",\"title\":");
        try jsonStr(lw, title);
        try lw.writeAll(",\"agent\":");
        try jsonStr(lw, agent);
        try lw.writeAll(",\"model\":");
        try jsonStr(lw, effective_model);
        try lw.writeAll(",\"status\":\"pending\"");
        try lw.writeAll(",\"depends_on\":");
        try writeJsonStrArray(lw, depends_on);
        try lw.writeAll(",\"scope\":{\"allowed_paths\":");
        if (allowed_paths.len > 0) {
            try writeJsonStrArray(lw, allowed_paths);
        } else {
            try lw.writeAll("[\".\"]");
        }
        try lw.print(",\"read_only\":{s},\"permission_mode\":", .{if (read_only) "true" else "false"});
        try jsonStr(lw, effective_perm);
        try lw.writeAll(",\"can_integrate\":false}");
        try lw.writeAll(",\"worktree_dir\":");
        try jsonStr(lw, wt_dir);
        try lw.writeAll(",\"worktree_cmd\":");
        try jsonStr(lw, wt_cmd);
        try lw.writeAll(",\"launch_cmd\":");
        try jsonStr(lw, launch_cmd);
        try lw.writeAll(",\"verify_cmd\":");
        try jsonStr(lw, verify_cmd);
        try lw.writeAll(",\"receipt\":null}");
    }
    try lw.writeAll("]}");

    const ledger_path = try runFilePath(a, env, run_id);
    try sys.writeFile(ledger_path, ledger.written());

    var out: Writer.Allocating = .init(a);
    const ow = &out.writer;
    try ow.writeAll("{\"action\":\"plan\",\"ledger_path\":");
    try jsonStr(ow, ledger_path);
    try ow.writeAll(",\"run\":");
    try ow.writeAll(ledger.written());
    try ow.writeAll(",\"next\":\"Lanza solo tareas sin depends_on pendientes; registra cada resultado con agentspipeline(action=\\\"receipt\\\", run_id=..., task_id=..., ...). Para integrar despues de revisar diffs, llama verify con integration_authorized=true.\"}");
    return out.written();
}

pub fn runReceiptJson(a: std.mem.Allocator, env: *const std.process.Environ.Map, args: std.json.ObjectMap) ![]u8 {
    const raw_run_id = strField(args, "run_id") orelse return error.MissingRunId;
    const raw_task_id = strField(args, "task_id") orelse return error.MissingTaskId;
    const task_id = try sanitizeId(a, raw_task_id);
    const new_status = strField(args, "status") orelse "completed";
    const commit_sha = strField(args, "commit_sha") orelse "";
    const verify_output = strField(args, "verify_output") orelse "";
    const exit_code = intField(args, "exit_code", 0);
    const changed_paths = try readStringArray(a, args, "changed_paths");

    const path = try runFilePath(a, env, raw_run_id);
    const raw = try sys.readFileAlloc(a, path, 4 * 1024 * 1024);
    const parsed = try std.json.parseFromSlice(std.json.Value, a, raw, .{});
    if (parsed.value != .object) return error.InvalidLedger;
    const root_obj = parsed.value.object;
    const tasks_val = root_obj.get("tasks") orelse return error.InvalidLedger;
    if (tasks_val != .array) return error.InvalidLedger;

    const now_ms = sys.realtimeMs();
    var found = false;

    var lw: Writer.Allocating = .init(a);
    const w = &lw.writer;
    try w.writeAll("{\"run_id\":");
    try jsonStr(w, strField(root_obj, "run_id") orelse raw_run_id);
    try w.writeAll(",\"repo_root\":");
    try jsonStr(w, strField(root_obj, "repo_root") orelse ".");
    try w.writeAll(",\"base_ref\":");
    try jsonStr(w, strField(root_obj, "base_ref") orelse "HEAD");
    try w.writeAll(",\"wave_name\":");
    try jsonStr(w, strField(root_obj, "wave_name") orelse "wave");
    try w.print(",\"created_at_ms\":{d},\"updated_at_ms\":{d}", .{ intField(root_obj, "created_at_ms", now_ms), now_ms });
    try w.print(",\"task_count\":{d},\"tasks\":[", .{tasks_val.array.items.len});

    for (tasks_val.array.items, 0..) |item, i| {
        if (i > 0) try w.writeByte(',');
        if (item != .object) return error.InvalidLedger;
        const tobj = item.object;
        const tid = strField(tobj, "id") orelse "";
        if (std.mem.eql(u8, tid, task_id)) {
            found = true;
            try w.writeAll("{\"id\":");
            try jsonStr(w, tid);
            try w.writeAll(",\"title\":");
            try jsonStr(w, strField(tobj, "title") orelse tid);
            try w.writeAll(",\"agent\":");
            try jsonStr(w, strField(tobj, "agent") orelse "claude");
            try w.writeAll(",\"model\":");
            try jsonStr(w, strField(tobj, "model") orelse "haiku");
            try w.writeAll(",\"status\":");
            try jsonStr(w, new_status);
            try w.writeAll(",\"depends_on\":");
            if (tobj.get("depends_on")) |dv| try std.json.Stringify.value(dv, .{}, w) else try w.writeAll("[]");
            try w.writeAll(",\"scope\":");
            if (tobj.get("scope")) |sv| try std.json.Stringify.value(sv, .{}, w) else try w.writeAll("{}");
            try w.writeAll(",\"worktree_dir\":");
            try jsonStr(w, strField(tobj, "worktree_dir") orelse "");
            try w.writeAll(",\"worktree_cmd\":");
            try jsonStr(w, strField(tobj, "worktree_cmd") orelse "");
            try w.writeAll(",\"launch_cmd\":");
            try jsonStr(w, strField(tobj, "launch_cmd") orelse "");
            try w.writeAll(",\"verify_cmd\":");
            try jsonStr(w, strField(tobj, "verify_cmd") orelse "");
            try w.writeAll(",\"receipt\":{\"recorded_at_ms\":");
            try w.print("{d},\"status\":", .{now_ms});
            try jsonStr(w, new_status);
            try w.writeAll(",\"commit_sha\":");
            try jsonStr(w, commit_sha);
            try w.print(",\"exit_code\":{d},\"changed_paths\":", .{exit_code});
            try writeJsonStrArray(w, changed_paths);
            try w.writeAll(",\"verify_output\":");
            try jsonStr(w, verify_output);
            try w.writeAll(",\"integration_authorized\":false}}");
        } else {
            try std.json.Stringify.value(item, .{}, w);
        }
    }
    try w.writeAll("]}");
    if (!found) return error.TaskNotFound;

    try sys.writeFile(path, lw.written());

    var out: Writer.Allocating = .init(a);
    const ow = &out.writer;
    try ow.writeAll("{\"action\":\"receipt\",\"run_id\":");
    try jsonStr(ow, strField(root_obj, "run_id") orelse raw_run_id);
    try ow.writeAll(",\"task_id\":");
    try jsonStr(ow, task_id);
    try ow.writeAll(",\"status\":");
    try jsonStr(ow, new_status);
    try ow.writeAll(",\"ledger_path\":");
    try jsonStr(ow, path);
    try ow.writeAll(",\"integration_authorized\":false,\"note\":\"Recibo guardado en disco; el worktree sigue aislado hasta aprobacion explicita de integracion.\"}");
    return out.written();
}

pub fn runStatusJson(a: std.mem.Allocator, env: *const std.process.Environ.Map, args: std.json.ObjectMap, action_name: []const u8) ![]u8 {
    const raw_run_id = strField(args, "run_id") orelse return error.MissingRunId;
    const path = try runFilePath(a, env, raw_run_id);
    const raw = try sys.readFileAlloc(a, path, 4 * 1024 * 1024);
    const parsed = try std.json.parseFromSlice(std.json.Value, a, raw, .{});
    if (parsed.value != .object) return error.InvalidLedger;
    const root_obj = parsed.value.object;
    const tasks_val = root_obj.get("tasks") orelse return error.InvalidLedger;
    if (tasks_val != .array) return error.InvalidLedger;

    var completed_ids: std.ArrayList([]const u8) = .empty;
    var failed_ids: std.ArrayList([]const u8) = .empty;
    var ready_tasks: std.ArrayList(std.json.ObjectMap) = .empty;
    var blocked_ids: std.ArrayList([]const u8) = .empty;

    for (tasks_val.array.items) |item| {
        if (item != .object) continue;
        const st = strField(item.object, "status") orelse "pending";
        const tid = strField(item.object, "id") orelse "";
        if (std.mem.eql(u8, st, "completed")) {
            try completed_ids.append(a, tid);
        } else if (std.mem.eql(u8, st, "failed")) {
            try failed_ids.append(a, tid);
        }
    }

    for (tasks_val.array.items) |item| {
        if (item != .object) continue;
        const st = strField(item.object, "status") orelse "pending";
        const tid = strField(item.object, "id") orelse "";
        if (std.mem.eql(u8, st, "completed") or std.mem.eql(u8, st, "failed")) continue;

        const deps = try readStringArray(a, item.object, "depends_on");
        var all_deps_done = true;
        for (deps) |d| {
            var found_done = false;
            for (completed_ids.items) |cid| {
                if (std.mem.eql(u8, cid, d)) {
                    found_done = true;
                    break;
                }
            }
            if (!found_done) {
                all_deps_done = false;
                break;
            }
        }
        if (all_deps_done) {
            try ready_tasks.append(a, item.object);
        } else {
            try blocked_ids.append(a, tid);
        }
    }

    var out: Writer.Allocating = .init(a);
    const ow = &out.writer;
    try ow.writeAll("{\"action\":");
    try jsonStr(ow, action_name);
    try ow.writeAll(",\"run_id\":");
    try jsonStr(ow, strField(root_obj, "run_id") orelse raw_run_id);
    try ow.writeAll(",\"ledger_path\":");
    try jsonStr(ow, path);
    try ow.writeAll(",\"completed_tasks\":");
    try writeJsonStrArray(ow, completed_ids.items);
    try ow.writeAll(",\"failed_tasks\":");
    try writeJsonStrArray(ow, failed_ids.items);
    try ow.writeAll(",\"blocked_by_dependencies\":");
    try writeJsonStrArray(ow, blocked_ids.items);
    try ow.writeAll(",\"ready_to_resume\":[");
    for (ready_tasks.items, 0..) |rt, i| {
        if (i > 0) try ow.writeByte(',');
        try ow.writeAll("{\"id\":");
        try jsonStr(ow, strField(rt, "id") orelse "");
        try ow.writeAll(",\"agent\":");
        try jsonStr(ow, strField(rt, "agent") orelse "claude");
        try ow.writeAll(",\"worktree_dir\":");
        try jsonStr(ow, strField(rt, "worktree_dir") orelse "");
        try ow.writeAll(",\"launch_cmd\":");
        try jsonStr(ow, strField(rt, "launch_cmd") orelse "");
        try ow.writeByte('}');
    }
    try ow.writeAll("],\"recoverable\":true}");
    return out.written();
}

pub fn runVerifyJson(a: std.mem.Allocator, env: *const std.process.Environ.Map, args: std.json.ObjectMap) ![]u8 {
    var repo_root = strField(args, "repo_root") orelse ".";
    var wave_name = try sanitizeId(a, strField(args, "wave_name") orelse "wave");
    const integration_authorized = boolField(args, "integration_authorized", false);
    const destructive_approved = boolField(args, "destructive_approved", false);

    var commits: std.ArrayList([]const u8) = .empty;
    var unfinished_tasks: std.ArrayList([]const u8) = .empty;

    if (strField(args, "run_id")) |raw_rid| {
        const path = try runFilePath(a, env, raw_rid);
        const raw = try sys.readFileAlloc(a, path, 4 * 1024 * 1024);
        const parsed = try std.json.parseFromSlice(std.json.Value, a, raw, .{});
        if (parsed.value != .object) return error.InvalidLedger;
        const root_obj = parsed.value.object;
        if (strField(root_obj, "repo_root")) |rr| repo_root = rr;
        if (strField(root_obj, "wave_name")) |wn| wave_name = wn;
        if (root_obj.get("tasks")) |tv| {
            if (tv == .array) {
                for (tv.array.items) |item| {
                    if (item != .object) continue;
                    const tid = strField(item.object, "id") orelse "";
                    const st = strField(item.object, "status") orelse "pending";
                    if (!std.mem.eql(u8, st, "completed")) {
                        try unfinished_tasks.append(a, tid);
                    }
                    if (item.object.get("receipt")) |rv| {
                        if (rv == .object) {
                            if (strField(rv.object, "commit_sha")) |sha| {
                                try commits.append(a, sha);
                            }
                        }
                    }
                }
            }
        }
    }

    if (args.get("commits")) |cv| {
        if (cv == .array) {
            for (cv.array.items) |c| {
                if (c == .string and c.string.len > 0) {
                    try commits.append(a, c.string);
                }
            }
        }
    }

    const vcmds = try readStringArray(a, args, "verify_cmds");
    if (!destructive_approved) {
        for (vcmds) |vc| {
            if (containsDestructivePattern(vc) != null) return error.DestructiveCommandBlocked;
        }
    }

    var inspect_cmds: std.ArrayList([]const u8) = .empty;
    for (commits.items) |sha| {
        try inspect_cmds.append(a, try std.fmt.allocPrint(a, "git -C \"{s}\" show --stat {s}", .{ repo_root, sha }));
    }

    const can_integrate = integration_authorized and unfinished_tasks.items.len == 0 and commits.items.len > 0;

    var w: Writer.Allocating = .init(a);
    const ww = &w.writer;
    try ww.writeAll("{\"action\":\"verify\",\"wave_name\":");
    try jsonStr(ww, wave_name);
    try ww.print(",\"integration_authorized\":{s},\"integration_allowed\":{s}", .{
        if (integration_authorized) "true" else "false",
        if (can_integrate) "true" else "false",
    });
    try ww.writeAll(",\"unfinished_tasks\":");
    try writeJsonStrArray(ww, unfinished_tasks.items);
    try ww.writeAll(",\"commits\":");
    try writeJsonStrArray(ww, commits.items);
    try ww.writeAll(",\"diff_inspect_cmds\":");
    try writeJsonStrArray(ww, inspect_cmds.items);

    if (can_integrate) {
        var cp_cmd: std.ArrayList(u8) = .empty;
        try cp_cmd.appendSlice(a, "cd \"");
        try cp_cmd.appendSlice(a, repo_root);
        try cp_cmd.appendSlice(a, "\" && git cherry-pick");
        for (commits.items) |sha| {
            try cp_cmd.append(a, ' ');
            try cp_cmd.appendSlice(a, sha);
        }
        try ww.writeAll(",\"cherry_pick_cmd\":");
        try jsonStr(ww, cp_cmd.items);
    } else {
        try ww.writeAll(",\"cherry_pick_cmd\":null,\"gate_reason\":");
        if (!integration_authorized) {
            try jsonStr(ww, "Los worktrees aislan cambios pero NO autorizan integracion; inspecciona diff_inspect_cmds y reintenta con integration_authorized=true.");
        } else if (unfinished_tasks.items.len > 0) {
            try jsonStr(ww, "Hay tareas incompletas en el run_id; resuelve o completa dependencias antes de integrar.");
        } else {
            try jsonStr(ww, "No hay commits registrados para integrar.");
        }
    }

    try ww.writeAll(",\"verify_cmds\":");
    try writeJsonStrArray(ww, vcmds);
    try ww.writeAll(",\"gates\":[");
    try jsonStr(ww, "Worktree isolation != autorizacion de integracion; revisar diffs antes de cherry-pick.");
    try ww.writeAll(",");
    try jsonStr(ww, "Todas las pruebas deben correr DESPUES del ultimo cherry-pick o fix de integracion sobre commit fijo.");
    try ww.writeAll(",");
    try jsonStr(ww, "Preservar todos los worktrees temporales y archivos no rastreados (nunca ejecutar comandos destructivos sin aprobacion humana).");
    try ww.writeAll("]}");
    return w.written();
}

pub fn handleToolCall(a: std.mem.Allocator, env: *const std.process.Environ.Map, args: std.json.ObjectMap) ![]u8 {
    const action = strField(args, "action") orelse "discover";
    if (std.mem.eql(u8, action, "discover")) {
        return try runDiscoverJson(a, env);
    } else if (std.mem.eql(u8, action, "plan")) {
        return try runPlanJson(a, env, args);
    } else if (std.mem.eql(u8, action, "receipt")) {
        return try runReceiptJson(a, env, args);
    } else if (std.mem.eql(u8, action, "status") or std.mem.eql(u8, action, "resume")) {
        return try runStatusJson(a, env, args, action);
    } else if (std.mem.eql(u8, action, "verify")) {
        return try runVerifyJson(a, env, args);
    }
    return error.UnknownAction;
}

pub fn runCli(a: std.mem.Allocator, env: *const std.process.Environ.Map, cli_args: []const []const u8) !void {
    if (cli_args.len == 0 or std.mem.eql(u8, cli_args[0], "--discover") or std.mem.eql(u8, cli_args[0], "discover") or std.mem.eql(u8, cli_args[0], "--json")) {
        const out = try runDiscoverJson(a, env);
        try sys.writeAll(1, out);
        try sys.writeAll(1, "\n");
        return;
    }
    if (std.mem.eql(u8, cli_args[0], "status") and cli_args.len >= 2) {
        const fake_json = try std.fmt.allocPrint(a, "{{\"action\":\"status\",\"run_id\":\"{s}\"}}", .{cli_args[1]});
        const parsed = try std.json.parseFromSlice(std.json.Value, a, fake_json, .{});
        const out = try runStatusJson(a, env, parsed.value.object, "status");
        try sys.writeAll(1, out);
        try sys.writeAll(1, "\n");
        return;
    }
    try sys.writeAll(1, CLI_HELP);
}

test "pipeline enforces 5 invariants: least-privilege, durable run_id/receipts, recovery, integration gate, destructive guard" {
    const a = std.testing.allocator;
    var arena_state = std.heap.ArenaAllocator.init(a);
    defer arena_state.deinit();
    const aa = arena_state.allocator();

    const tmp_dir = "/tmp/isymcp_pipeline_test_runs";
    var env: std.process.Environ.Map = .init(aa);
    try env.put("PATH", "/usr/bin:/bin");
    try env.put("ISYMCP_PIPELINE_DIR", tmp_dir);

    // 1. Discover exposes dynamic sizing & 5 invariants
    const disc = try runDiscoverJson(aa, &env);
    try std.testing.expect(std.mem.indexOf(u8, disc, "\"fixed_agent_count\":false") != null);
    try std.testing.expect(std.mem.indexOf(u8, disc, "interactive_intake_questions") != null);

    // 2. Plan creates durable run_id, dependency graph, and least-privilege flags (NO --dangerously-*)
    const plan_json =
        \\{"repo_root":"/tmp/demo","base_ref":"HEAD","wave_name":"w11","run_id":"test_run_w11",
        \\"tasks":[
        \\  {"id":"a","title":"Fix parser","agent":"claude","model":"haiku","allowed_paths":["src/parser.py"]},
        \\  {"id":"b","title":"Fuzz IR","agent":"codex","depends_on":["a"],"read_only":true}
        \\]}
    ;
    const parsed_plan = try std.json.parseFromSlice(std.json.Value, aa, plan_json, .{});
    const plan = try runPlanJson(aa, &env, parsed_plan.value.object);
    try std.testing.expect(std.mem.indexOf(u8, plan, "\"task_count\":2") != null);
    try std.testing.expect(std.mem.indexOf(u8, plan, "--dangerously-") == null);
    try std.testing.expect(std.mem.indexOf(u8, plan, "--permission-mode acceptEdits") != null);
    try std.testing.expect(std.mem.indexOf(u8, plan, "-s read-only") != null);
    try std.testing.expect(std.mem.indexOf(u8, plan, "\"can_integrate\":false") != null);

    // 3. Verify blocks integration without integration_authorized=true
    const v_blocked_args = try std.json.parseFromSlice(std.json.Value, aa, "{\"run_id\":\"test_run_w11\"}", .{});
    const v_blocked = try runVerifyJson(aa, &env, v_blocked_args.value.object);
    try std.testing.expect(std.mem.indexOf(u8, v_blocked, "\"integration_allowed\":false") != null);

    // 4. Record receipt for task a -> status/resume unlocks dependent task b & preserves receipt a
    const rec_args = try std.json.parseFromSlice(std.json.Value, aa, "{\"run_id\":\"test_run_w11\",\"task_id\":\"a\",\"status\":\"completed\",\"commit_sha\":\"abc1234\",\"exit_code\":0}", .{});
    const rec = try runReceiptJson(aa, &env, rec_args.value.object);
    try std.testing.expect(std.mem.indexOf(u8, rec, "\"integration_authorized\":false") != null);

    const st_args = try std.json.parseFromSlice(std.json.Value, aa, "{\"run_id\":\"test_run_w11\"}", .{});
    const st = try runStatusJson(aa, &env, st_args.value.object, "resume");
    try std.testing.expect(std.mem.indexOf(u8, st, "\"completed_tasks\":[\"a\"]") != null);
    try std.testing.expect(std.mem.indexOf(u8, st, "\"id\":\"b\"") != null);

    // 5. Destructive command in planner prompt/verify is rejected
    const bad_plan = try std.json.parseFromSlice(std.json.Value, aa, "{\"tasks\":[{\"id\":\"x\",\"prompt\":\"run rm -rf /tmp/foo\"}]}", .{});
    try std.testing.expectError(error.DestructiveCommandBlocked, runPlanJson(aa, &env, bad_plan.value.object));
}
