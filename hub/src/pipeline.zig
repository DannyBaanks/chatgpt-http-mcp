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
    \\  agentspipeline(action="batonpass", run_id="...", task_id="...", stall_reason="...", context_summary="...", partial_log_tail="...", fallback_agent="codex")
    \\  agentspipeline(action="status", run_id="...")
    \\  agentspipeline(action="resume", run_id="...")
    \\  agentspipeline(action="verify", run_id="...", integration_authorized=true, integration_head="<sha>", verify_cmds=[...])
    \\  agentspipeline(action="integration_receipt", run_id="...", task_id="...|full_suite", head_sha="...", gate_exit_code=0, failures=[...])
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

fn defaultModelForAgent(agent: []const u8) []const u8 {
    if (std.mem.eql(u8, agent, "codex")) return "gpt-6-luna";
    if (std.mem.eql(u8, agent, "openisy")) return "nvidia/minimaxai/minimax-m3.1-flash";
    if (std.mem.eql(u8, agent, "subagent")) return "inherit";
    return "haiku";
}

fn defaultPermForAgent(agent: []const u8, read_only: bool) []const u8 {
    if (read_only) {
        return if (std.mem.eql(u8, agent, "codex")) "read-only" else "plan";
    }
    return if (std.mem.eql(u8, agent, "codex")) "workspace-write" else "acceptEdits";
}

fn buildLaunchCmd(
    a: std.mem.Allocator,
    agent: []const u8,
    model: []const u8,
    perm: []const u8,
    wt_dir: []const u8,
    prompt: []const u8,
) ![]const u8 {
    if (std.mem.eql(u8, agent, "codex")) {
        // El sandbox workspace-write de codex solo deja escribir el worktree;
        // su .git vive en el repo principal y el worker no podia commitear
        // (index.lock de solo lectura). Se abren SOLO objects/ y la carpeta de
        // este worktree (HEAD desacoplado, index, reflog), no refs ni ramas ajenas.
        if (std.mem.eql(u8, perm, "workspace-write")) {
            return try std.fmt.allocPrint(
                a,
                "cd \"{s}\" && codex exec -s {s} --add-dir \"$(git rev-parse --path-format=absolute --git-common-dir)/objects\" --add-dir \"$(git rev-parse --absolute-git-dir)\" << 'EOF'\n{s}\nEOF",
                .{ wt_dir, perm, prompt },
            );
        }
        return try std.fmt.allocPrint(a, "cd \"{s}\" && codex exec -s {s} << 'EOF'\n{s}\nEOF", .{ wt_dir, perm, prompt });
    } else if (std.mem.eql(u8, agent, "openisy")) {
        return try std.fmt.allocPrint(a, "cd \"{s}\" && openisy run --standalone --auto -m {s} << 'EOF'\n{s}\nEOF", .{ wt_dir, model, prompt });
    } else if (std.mem.eql(u8, agent, "subagent")) {
        return try std.fmt.allocPrint(a, "invoke_subagent / swarm(workspace='share', model={s}) -> {s}", .{ model, prompt });
    }
    return try std.fmt.allocPrint(a, "cd \"{s}\" && claude -p --permission-mode {s} --model {s} << 'EOF'\n{s}\nEOF", .{ wt_dir, perm, model, prompt });
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

    // Compuerta de integración de la ola (ver runIntegrationReceiptJson):
    // rama que recibe los cherry-picks, fallos conocidos antes de la ola y
    // comandos que se corren DESPUÉS de cada cherry-pick, no solo en el worker.
    const integration_ref = strField(args, "integration_ref") orelse base_ref;
    const baseline_failures = try readStringArray(a, args, "baseline_failures");
    const full_suite_cmd = strField(args, "full_suite_cmd") orelse "";
    var gate_cmds: std.ArrayList([]const u8) = .empty;
    for (try readStringArray(a, args, "integration_gate_cmds")) |gc| try gate_cmds.append(a, gc);
    const explicit_gate = gate_cmds.items.len > 0;
    var infos: std.ArrayList(PlanTaskInfo) = .empty;

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

        const effective_perm = strField(obj, "permission_mode") orelse defaultPermForAgent(agent, read_only);
        const fallback_agent = strField(obj, "fallback_agent") orelse (if (std.mem.eql(u8, agent, "openisy")) "codex" else if (std.mem.eql(u8, agent, "codex")) "claude" else "codex");
        const fallback_model = strField(obj, "fallback_model") orelse (if (std.mem.eql(u8, fallback_agent, "claude")) "sonnet" else defaultModelForAgent(fallback_agent));

        const scope_str = if (allowed_paths.len > 0)
            try std.mem.join(a, ", ", allowed_paths)
        else
            ".";

        const wt_dir = try std.fmt.allocPrint(a, "/var/tmp/{s}_wt_{s}_{s}", .{ slug, wave_name, tid });
        const wt_cmd = try std.fmt.allocPrint(a, "git -C \"{s}\" worktree add --detach \"{s}\" {s}", .{ repo_root, wt_dir, base_ref });

        try infos.append(a, .{ .id = tid, .paths = allowed_paths, .deps = depends_on });
        if (!explicit_gate and !hasStr(gate_cmds.items, verify_cmd)) try gate_cmds.append(a, verify_cmd);

        const base_prompt = try std.fmt.allocPrint(
            a,
            "Run {s} | Task {s} ({s}) in isolated worktree {s}. Scope allowed_paths=[{s}] read_only={s}. Task: {s}. Verify with: {s}. Invariants: stay strictly inside your allowed_paths; do NOT run destructive commands or delete worktrees/untracked files; commit only your own files with 'git commit -- <files>'; do NOT merge/cherry-pick into main branch; report exact commit_sha and observed test output.",
            .{ run_id, tid, title, wt_dir, scope_str, if (read_only) "true" else "false", raw_prompt, verify_cmd },
        );
        const worker_prompt = try std.fmt.allocPrint(
            a,
            "{s} Integration contract: your verify command is NOT the integration gate. Before reporting, if {s} moved past your base, rebase your commit onto it (git rebase {s}) and re-run verify there. Report verified_on_sha = the parent commit you verified on (git rev-parse HEAD^ after committing) and list EVERY failing test id you saw, including ones outside your task.",
            .{ base_prompt, integration_ref, integration_ref },
        );

        const effective_model = model orelse defaultModelForAgent(agent);
        const launch_cmd = try buildLaunchCmd(a, agent, effective_model, effective_perm, wt_dir, worker_prompt);

        if (idx > 0) try lw.writeByte(',');
        try lw.writeAll("{\"id\":");
        try jsonStr(lw, tid);
        try lw.writeAll(",\"title\":");
        try jsonStr(lw, title);
        try lw.writeAll(",\"prompt\":");
        try jsonStr(lw, raw_prompt);
        try lw.writeAll(",\"agent\":");
        try jsonStr(lw, agent);
        try lw.writeAll(",\"model\":");
        try jsonStr(lw, effective_model);
        try lw.writeAll(",\"fallback_agent\":");
        try jsonStr(lw, fallback_agent);
        try lw.writeAll(",\"fallback_model\":");
        try jsonStr(lw, fallback_model);
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
        try lw.writeAll(",\"handoff_count\":0,\"handoff_history\":[]");
        try lw.writeAll(",\"receipt\":null}");
    }
    try lw.writeAll("]");

    const overlaps = try findPathOverlaps(a, infos.items);
    try lw.writeAll(",\"integration_ref\":");
    try jsonStr(lw, integration_ref);
    try lw.writeAll(",\"baseline_failures\":");
    try writeJsonStrArray(lw, baseline_failures);
    try lw.writeAll(",\"integration_gate_cmds\":");
    try writeJsonStrArray(lw, gate_cmds.items);
    try lw.writeAll(",\"full_suite_cmd\":");
    try jsonStr(lw, full_suite_cmd);
    try lw.writeAll(",\"path_overlaps\":");
    try writeOverlaps(lw, overlaps);
    try lw.writeAll(",\"integration_log\":[]}");

    const ledger_path = try runFilePath(a, env, run_id);
    try sys.writeFile(ledger_path, ledger.written());

    var out: Writer.Allocating = .init(a);
    const ow = &out.writer;
    try ow.writeAll("{\"action\":\"plan\",\"ledger_path\":");
    try jsonStr(ow, ledger_path);
    try ow.writeAll(",\"run\":");
    try ow.writeAll(ledger.written());
    if (overlaps.len > 0) {
        try ow.writeAll(",\"overlap_warning\":");
        try jsonStr(ow, "Hay tareas paralelas (sin depends_on entre ellas) que tocan las mismas rutas: van a chocar al integrar y sus interacciones solo aparecen combinadas. Agrega depends_on, acota allowed_paths o reparte por zona de codigo; si las dejas paralelas, la integracion serial con gate por paso es obligatoria.");
    }
    try ow.writeAll(",\"next\":\"Lanza solo tareas sin depends_on pendientes; registra cada resultado con agentspipeline(action=\\\"receipt\\\", run_id=..., task_id=..., verified_on_sha=...). Para integrar despues de revisar diffs, llama verify con integration_authorized=true y sigue integration_steps de uno en uno: cherry-pick, gate, integration_receipt.\"}");
    return out.written();
}

const PlanTaskInfo = struct {
    id: []const u8,
    paths: []const []const u8,
    deps: []const []const u8,
};

const PathOverlap = struct {
    a: []const u8,
    b: []const u8,
    path_a: []const u8,
    path_b: []const u8,
};

fn hasStr(list: []const []const u8, s: []const u8) bool {
    for (list) |x| if (std.mem.eql(u8, x, s)) return true;
    return false;
}

fn normPath(p: []const u8) []const u8 {
    var s = p;
    while (std.mem.startsWith(u8, s, "./")) s = s[2..];
    return std.mem.trimEnd(u8, s, "/");
}

/// Dos alcances se pisan si uno contiene al otro. "." (o vacío) es todo el repo.
pub fn pathsOverlap(p: []const u8, q: []const u8) bool {
    const x = normPath(p);
    const y = normPath(q);
    if (x.len == 0 or y.len == 0 or std.mem.eql(u8, x, ".") or std.mem.eql(u8, y, ".")) return true;
    if (std.mem.eql(u8, x, y)) return true;
    if (y.len > x.len and std.mem.startsWith(u8, y, x) and y[x.len] == '/') return true;
    if (x.len > y.len and std.mem.startsWith(u8, x, y) and x[y.len] == '/') return true;
    return false;
}

fn dependsOn(a: std.mem.Allocator, infos: []const PlanTaskInfo, from: usize, target: []const u8, depth: usize) bool {
    if (depth > infos.len) return false;
    for (infos[from].deps) |raw_dep| {
        const dep = sanitizeId(a, raw_dep) catch raw_dep;
        if (std.mem.eql(u8, dep, target)) return true;
        for (infos, 0..) |inf, k| {
            if (std.mem.eql(u8, inf.id, dep) and dependsOn(a, infos, k, target, depth + 1)) return true;
        }
    }
    return false;
}

/// Pares de tareas paralelas (sin cadena depends_on entre ellas) con rutas
/// que se pisan: candidatas a conflicto de cherry-pick y a bugs de interacción.
fn findPathOverlaps(a: std.mem.Allocator, infos: []const PlanTaskInfo) ![]const PathOverlap {
    const whole_repo = [_][]const u8{"."};
    var out: std.ArrayList(PathOverlap) = .empty;
    for (infos, 0..) |ia, i| {
        for (infos[i + 1 ..], i + 1..) |ib, j| {
            if (dependsOn(a, infos, i, ib.id, 0) or dependsOn(a, infos, j, ia.id, 0)) continue;
            const pa: []const []const u8 = if (ia.paths.len > 0) ia.paths else &whole_repo;
            const pb: []const []const u8 = if (ib.paths.len > 0) ib.paths else &whole_repo;
            pair: for (pa) |x| {
                for (pb) |y| {
                    if (pathsOverlap(x, y)) {
                        try out.append(a, .{ .a = ia.id, .b = ib.id, .path_a = x, .path_b = y });
                        break :pair;
                    }
                }
            }
        }
    }
    return out.items;
}

fn writeOverlaps(w: anytype, overlaps: []const PathOverlap) !void {
    try w.writeByte('[');
    for (overlaps, 0..) |o, i| {
        if (i > 0) try w.writeByte(',');
        try w.writeAll("{\"tasks\":[");
        try jsonStr(w, o.a);
        try w.writeByte(',');
        try jsonStr(w, o.b);
        try w.writeAll("],\"paths\":[");
        try jsonStr(w, o.path_a);
        try w.writeByte(',');
        try jsonStr(w, o.path_b);
        try w.writeAll("]}");
    }
    try w.writeByte(']');
}

/// receipt/batonpass reescriben el ledger campo a campo; esto conserva los
/// campos de nivel raíz que no conocen (compuerta e integration_log).
fn carryRootExtras(a: std.mem.Allocator, old_root: std.json.ObjectMap, new_json: []const u8) ![]u8 {
    const parsed = try std.json.parseFromSlice(std.json.Value, a, new_json, .{});
    if (parsed.value != .object) return error.InvalidLedger;
    var root = parsed.value.object;
    var it = old_root.iterator();
    while (it.next()) |kv| {
        if (!root.contains(kv.key_ptr.*)) try root.put(a, kv.key_ptr.*, kv.value_ptr.*);
    }
    return try std.json.Stringify.valueAlloc(a, std.json.Value{ .object = root }, .{});
}

fn loadLedger(a: std.mem.Allocator, env: *const std.process.Environ.Map, raw_run_id: []const u8) !struct { path: []const u8, root: std.json.ObjectMap } {
    const path = try runFilePath(a, env, raw_run_id);
    const raw = try sys.readFileAlloc(a, path, 4 * 1024 * 1024);
    const parsed = try std.json.parseFromSlice(std.json.Value, a, raw, .{});
    if (parsed.value != .object) return error.InvalidLedger;
    return .{ .path = path, .root = parsed.value.object };
}

fn valueStrArray(a: std.mem.Allocator, v: ?std.json.Value) ![]const []const u8 {
    const val = v orelse return &.{};
    if (val != .array) return &.{};
    var out: std.ArrayList([]const u8) = .empty;
    for (val.array.items) |item| {
        if (item == .string and item.string.len > 0) try out.append(a, item.string);
    }
    return out.items;
}

fn strArrayValue(a: std.mem.Allocator, items: []const []const u8) !std.json.Value {
    var arr = std.json.Array.init(a);
    for (items) |s| try arr.append(.{ .string = s });
    return .{ .array = arr };
}

fn minus(a: std.mem.Allocator, xs: []const []const u8, ys: []const []const u8) ![]const []const u8 {
    var out: std.ArrayList([]const u8) = .empty;
    for (xs) |x| {
        if (!hasStr(ys, x) and !hasStr(out.items, x)) try out.append(a, x);
    }
    return out.items;
}

fn shaMatches(x: []const u8, y: []const u8) bool {
    if (x.len < 7 or y.len < 7) return false;
    return std.mem.startsWith(u8, x, y) or std.mem.startsWith(u8, y, x);
}

/// Fallos aceptados como punto de partida del paso siguiente: los del último
/// gate que pasó, o el baseline si todavía no pasó ninguno. Un gate en
/// regresión no mueve la referencia (si no, repetirlo "pasaría").
fn acceptedFailures(a: std.mem.Allocator, root: std.json.ObjectMap) ![]const []const u8 {
    const baseline = try valueStrArray(a, root.get("baseline_failures"));
    const log = root.get("integration_log") orelse return baseline;
    if (log != .array) return baseline;
    var i = log.array.items.len;
    while (i > 0) {
        i -= 1;
        const e = log.array.items[i];
        if (e != .object) continue;
        const verdict = strField(e.object, "verdict") orelse "";
        if (std.mem.eql(u8, verdict, "pass")) {
            const f = try valueStrArray(a, e.object.get("failures"));
            var merged: std.ArrayList([]const u8) = .empty;
            for (f) |x| try merged.append(a, x);
            for (baseline) |x| if (!hasStr(merged.items, x)) try merged.append(a, x);
            return merged.items;
        }
    }
    return baseline;
}

/// Registra el gate corrido DESPUÉS de un cherry-pick (o la suite completa
/// final, task_id="full_suite") y clasifica cada fallo contra el baseline de la
/// ola y contra el último gate verde. El hub no corre pruebas: clasifica lo que
/// el orquestador observó, de forma determinista y persistente.
pub fn runIntegrationReceiptJson(a: std.mem.Allocator, env: *const std.process.Environ.Map, args: std.json.ObjectMap) ![]u8 {
    const raw_run_id = strField(args, "run_id") orelse return error.MissingRunId;
    const raw_task_id = strField(args, "task_id") orelse return error.MissingTaskId;
    const head_sha = strField(args, "head_sha") orelse return error.MissingHeadSha;
    const is_full = std.mem.eql(u8, raw_task_id, "full_suite");
    const task_id = if (is_full) raw_task_id else try sanitizeId(a, raw_task_id);
    const gate_exit_code = intField(args, "gate_exit_code", 0);
    const failures = try readStringArray(a, args, "failures");
    const notes = strField(args, "notes") orelse "";
    const conflict_resolved = boolField(args, "conflict_resolved", false);

    const led = try loadLedger(a, env, raw_run_id);
    var root = led.root;
    if (!is_full) {
        const tasks_val = root.get("tasks") orelse return error.InvalidLedger;
        if (tasks_val != .array) return error.InvalidLedger;
        var found = false;
        for (tasks_val.array.items) |t| {
            if (t == .object and std.mem.eql(u8, strField(t.object, "id") orelse "", task_id)) found = true;
        }
        if (!found) return error.TaskNotFound;
    }

    const baseline = try valueStrArray(a, root.get("baseline_failures"));
    const accepted = try acceptedFailures(a, root);
    const new_vs_baseline = try minus(a, failures, baseline);
    const new_this_step = try minus(a, failures, accepted);
    const fixed_vs_baseline = try minus(a, baseline, failures);
    const pre_existing = try minus(a, failures, new_vs_baseline);

    const verdict: []const u8 = if (new_this_step.len > 0)
        "regression"
    else if (gate_exit_code != 0 and failures.len == 0)
        "unclassified_failure"
    else
        "pass";

    const now_ms = sys.realtimeMs();
    var entry: std.json.ObjectMap = .empty;
    try entry.put(a, "task_id", .{ .string = task_id });
    try entry.put(a, "head_sha", .{ .string = head_sha });
    try entry.put(a, "gate_exit_code", .{ .integer = gate_exit_code });
    try entry.put(a, "verdict", .{ .string = verdict });
    try entry.put(a, "failures", try strArrayValue(a, failures));
    try entry.put(a, "new_this_step", try strArrayValue(a, new_this_step));
    try entry.put(a, "new_vs_baseline", try strArrayValue(a, new_vs_baseline));
    try entry.put(a, "fixed_vs_baseline", try strArrayValue(a, fixed_vs_baseline));
    try entry.put(a, "conflict_resolved", .{ .bool = conflict_resolved });
    try entry.put(a, "notes", .{ .string = notes });
    try entry.put(a, "recorded_at_ms", .{ .integer = now_ms });

    var log_arr = std.json.Array.init(a);
    if (root.get("integration_log")) |lv| {
        if (lv == .array) for (lv.array.items) |e| try log_arr.append(e);
    }
    try log_arr.append(.{ .object = entry });
    try root.put(a, "integration_log", .{ .array = log_arr });
    try root.put(a, "updated_at_ms", .{ .integer = now_ms });
    try sys.writeFile(led.path, try std.json.Stringify.valueAlloc(a, std.json.Value{ .object = root }, .{}));

    var out: Writer.Allocating = .init(a);
    const ow = &out.writer;
    try ow.writeAll("{\"action\":\"integration_receipt\",\"run_id\":");
    try jsonStr(ow, strField(root, "run_id") orelse raw_run_id);
    try ow.writeAll(",\"task_id\":");
    try jsonStr(ow, task_id);
    try ow.writeAll(",\"head_sha\":");
    try jsonStr(ow, head_sha);
    try ow.writeAll(",\"verdict\":");
    try jsonStr(ow, verdict);
    try ow.writeAll(",\"new_this_step\":");
    try writeJsonStrArray(ow, new_this_step);
    try ow.writeAll(",\"new_vs_baseline\":");
    try writeJsonStrArray(ow, new_vs_baseline);
    try ow.writeAll(",\"pre_existing\":");
    try writeJsonStrArray(ow, pre_existing);
    try ow.writeAll(",\"fixed_vs_baseline\":");
    try writeJsonStrArray(ow, fixed_vs_baseline);
    try ow.writeAll(",\"ledger_path\":");
    try jsonStr(ow, led.path);
    try ow.writeAll(",\"next\":");
    if (std.mem.eql(u8, verdict, "regression")) {
        try jsonStr(ow, "REGRESION atribuida a este paso: NO sigas con el siguiente cherry-pick. Despacha un fix (nueva tarea con depends_on, en worktree sobre head_sha) y vuelve a registrar este paso; revertir el cherry-pick es decision humana, nunca automatica.");
    } else if (std.mem.eql(u8, verdict, "unclassified_failure")) {
        try jsonStr(ow, "El gate salio != 0 pero no reportaste ids de fallo: no se puede clasificar. Reporta failures=[...] (p. ej. las lineas FAILED de pytest) antes de continuar.");
    } else if (is_full) {
        try jsonStr(ow, "Suite completa registrada sin fallos nuevos contra el ultimo gate verde: la ola puede cerrarse (verify mostrara integration_complete).");
    } else {
        try jsonStr(ow, "Paso verde. Llama verify(run_id, integration_authorized=true) para el siguiente paso de integration_steps.");
    }
    try ow.writeByte('}');
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
    const verified_on_sha = strField(args, "verified_on_sha") orelse "";

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
            try w.writeAll(",\"prompt\":");
            try jsonStr(w, strField(tobj, "prompt") orelse "");
            try w.writeAll(",\"agent\":");
            try jsonStr(w, strField(tobj, "agent") orelse "claude");
            try w.writeAll(",\"model\":");
            try jsonStr(w, strField(tobj, "model") orelse "haiku");
            try w.writeAll(",\"fallback_agent\":");
            try jsonStr(w, strField(tobj, "fallback_agent") orelse "codex");
            try w.writeAll(",\"fallback_model\":");
            try jsonStr(w, strField(tobj, "fallback_model") orelse "gpt-6-luna");
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
            try w.print(",\"handoff_count\":{d},\"handoff_history\":", .{intField(tobj, "handoff_count", 0)});
            if (tobj.get("handoff_history")) |hv| try std.json.Stringify.value(hv, .{}, w) else try w.writeAll("[]");
            try w.writeAll(",\"receipt\":{\"recorded_at_ms\":");
            try w.print("{d},\"status\":", .{now_ms});
            try jsonStr(w, new_status);
            try w.writeAll(",\"commit_sha\":");
            try jsonStr(w, commit_sha);
            try w.print(",\"exit_code\":{d},\"changed_paths\":", .{exit_code});
            try writeJsonStrArray(w, changed_paths);
            try w.writeAll(",\"verify_output\":");
            try jsonStr(w, verify_output);
            try w.writeAll(",\"verified_on_sha\":");
            try jsonStr(w, verified_on_sha);
            try w.writeAll(",\"integration_authorized\":false}}");
        } else {
            try std.json.Stringify.value(item, .{}, w);
        }
    }
    try w.writeAll("]}");
    if (!found) return error.TaskNotFound;

    try sys.writeFile(path, try carryRootExtras(a, root_obj, lw.written()));

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

const IntegrationStep = struct {
    task_id: []const u8,
    commit: []const u8,
    verified_on_sha: []const u8,
    done: bool,
};

pub fn runVerifyJson(a: std.mem.Allocator, env: *const std.process.Environ.Map, args: std.json.ObjectMap) ![]u8 {
    var repo_root = strField(args, "repo_root") orelse ".";
    var wave_name = try sanitizeId(a, strField(args, "wave_name") orelse "wave");
    const integration_authorized = boolField(args, "integration_authorized", false);
    const destructive_approved = boolField(args, "destructive_approved", false);
    const integration_head = strField(args, "integration_head") orelse "";

    var commits: std.ArrayList([]const u8) = .empty;
    var unfinished_tasks: std.ArrayList([]const u8) = .empty;
    var steps: std.ArrayList(IntegrationStep) = .empty;
    var integration_ref: []const u8 = "HEAD";
    var gate_cmds: []const []const u8 = &.{};
    var full_suite_cmd: []const u8 = "";
    var overlaps_count: usize = 0;
    var blocked_by: []const u8 = "";
    var blocked_verdict: []const u8 = "";
    var full_suite_done = false;

    if (strField(args, "run_id")) |raw_rid| {
        const led = try loadLedger(a, env, raw_rid);
        const root_obj = led.root;
        if (strField(root_obj, "repo_root")) |rr| repo_root = rr;
        if (strField(root_obj, "wave_name")) |wn| wave_name = wn;
        integration_ref = strField(root_obj, "integration_ref") orelse (strField(root_obj, "base_ref") orelse "HEAD");
        gate_cmds = try valueStrArray(a, root_obj.get("integration_gate_cmds"));
        full_suite_cmd = strField(root_obj, "full_suite_cmd") orelse "";
        if (root_obj.get("path_overlaps")) |pv| {
            if (pv == .array) overlaps_count = pv.array.items.len;
        }

        // Log de integración: qué pasos ya tienen gate verde y si el último
        // gate registrado bloquea (regresión / fallo sin clasificar).
        var passed_ids: std.ArrayList([]const u8) = .empty;
        if (root_obj.get("integration_log")) |lv| {
            if (lv == .array) {
                for (lv.array.items) |e| {
                    if (e != .object) continue;
                    const tid = strField(e.object, "task_id") orelse "";
                    const verdict = strField(e.object, "verdict") orelse "";
                    if (std.mem.eql(u8, verdict, "pass")) {
                        if (std.mem.eql(u8, tid, "full_suite")) full_suite_done = true else try passed_ids.append(a, tid);
                        if (std.mem.eql(u8, blocked_by, tid)) {
                            blocked_by = "";
                            blocked_verdict = "";
                        }
                    } else {
                        blocked_by = tid;
                        blocked_verdict = verdict;
                        if (std.mem.eql(u8, tid, "full_suite")) full_suite_done = false;
                    }
                }
            }
        }

        // Orden de integración: respeta depends_on (dependencias primero),
        // luego el orden del ledger.
        var ordered: std.ArrayList(std.json.ObjectMap) = .empty;
        if (root_obj.get("tasks")) |tv| {
            if (tv == .array) {
                var placed: std.ArrayList([]const u8) = .empty;
                var progress = true;
                while (progress) {
                    progress = false;
                    for (tv.array.items) |item| {
                        if (item != .object) continue;
                        const tid = strField(item.object, "id") orelse "";
                        if (hasStr(placed.items, tid)) continue;
                        var ready = true;
                        for (try readStringArray(a, item.object, "depends_on")) |d| {
                            const did = try sanitizeId(a, d);
                            if (!hasStr(placed.items, did)) {
                                ready = false;
                                break;
                            }
                        }
                        if (ready) {
                            try placed.append(a, tid);
                            try ordered.append(a, item.object);
                            progress = true;
                        }
                    }
                }
                for (tv.array.items) |item| {
                    if (item != .object) continue;
                    if (!hasStr(placed.items, strField(item.object, "id") orelse "")) try ordered.append(a, item.object);
                }
            }
        }

        for (ordered.items) |tobj| {
            const tid = strField(tobj, "id") orelse "";
            const st = strField(tobj, "status") orelse "pending";
            if (!std.mem.eql(u8, st, "completed")) try unfinished_tasks.append(a, tid);
            if (tobj.get("receipt")) |rv| {
                if (rv == .object) {
                    if (strField(rv.object, "commit_sha")) |sha| {
                        try commits.append(a, sha);
                        try steps.append(a, .{
                            .task_id = tid,
                            .commit = sha,
                            .verified_on_sha = strField(rv.object, "verified_on_sha") orelse "",
                            .done = hasStr(passed_ids.items, tid),
                        });
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
                    try steps.append(a, .{ .task_id = c.string, .commit = c.string, .verified_on_sha = "", .done = false });
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
    // Gate por paso: lo que el caller pase en verify_cmds + el gate de la ola.
    var step_gate: std.ArrayList([]const u8) = .empty;
    for (vcmds) |vc| try step_gate.append(a, vc);
    for (gate_cmds) |gc| if (!hasStr(step_gate.items, gc)) try step_gate.append(a, gc);

    var inspect_cmds: std.ArrayList([]const u8) = .empty;
    for (commits.items) |sha| {
        try inspect_cmds.append(a, try std.fmt.allocPrint(a, "git -C \"{s}\" show --stat {s}", .{ repo_root, sha }));
    }

    var next_idx: ?usize = null;
    for (steps.items, 0..) |stp, i| {
        if (!stp.done) {
            next_idx = i;
            break;
        }
    }
    const all_steps_done = steps.items.len > 0 and next_idx == null;
    const blocked = blocked_by.len > 0;
    const can_integrate = integration_authorized and unfinished_tasks.items.len == 0 and commits.items.len > 0 and !blocked;
    const integration_complete = all_steps_done and !blocked and (full_suite_done or full_suite_cmd.len == 0);

    var w: Writer.Allocating = .init(a);
    const ww = &w.writer;
    try ww.writeAll("{\"action\":\"verify\",\"wave_name\":");
    try jsonStr(ww, wave_name);
    try ww.print(",\"integration_authorized\":{s},\"integration_allowed\":{s},\"integration_mode\":\"serial\"", .{
        if (integration_authorized) "true" else "false",
        if (can_integrate) "true" else "false",
    });
    try ww.writeAll(",\"integration_ref\":");
    try jsonStr(ww, integration_ref);
    try ww.writeAll(",\"unfinished_tasks\":");
    try writeJsonStrArray(ww, unfinished_tasks.items);
    try ww.writeAll(",\"commits\":");
    try writeJsonStrArray(ww, commits.items);
    try ww.writeAll(",\"diff_inspect_cmds\":");
    try writeJsonStrArray(ww, inspect_cmds.items);

    // Recibos verificados sobre otra base: el verde del worker no cuenta
    // para la HEAD de integración actual.
    try ww.writeAll(",\"stale_receipts\":[");
    var first_stale = true;
    for (steps.items) |stp| {
        if (stp.done) continue;
        const reason: ?[]const u8 = if (stp.verified_on_sha.len == 0)
            "missing_verified_on_sha"
        else if (integration_head.len > 0 and !shaMatches(stp.verified_on_sha, integration_head))
            "base_moved"
        else
            null;
        if (reason) |r| {
            if (!first_stale) try ww.writeByte(',');
            first_stale = false;
            try ww.writeAll("{\"task_id\":");
            try jsonStr(ww, stp.task_id);
            try ww.writeAll(",\"verified_on_sha\":");
            try jsonStr(ww, stp.verified_on_sha);
            try ww.writeAll(",\"reason\":");
            try jsonStr(ww, r);
            try ww.writeByte('}');
        }
    }
    try ww.writeByte(']');

    try ww.writeAll(",\"integration_steps\":[");
    for (steps.items, 0..) |stp, i| {
        if (i > 0) try ww.writeByte(',');
        try ww.writeAll("{\"task_id\":");
        try jsonStr(ww, stp.task_id);
        try ww.writeAll(",\"commit\":");
        try jsonStr(ww, stp.commit);
        try ww.print(",\"done\":{s},\"cherry_pick_cmd\":", .{if (stp.done) "true" else "false"});
        try jsonStr(ww, try std.fmt.allocPrint(a, "git -C \"{s}\" cherry-pick {s}", .{ repo_root, stp.commit }));
        try ww.writeByte('}');
    }
    try ww.writeAll("],\"step_gate_cmds\":");
    try writeJsonStrArray(ww, step_gate.items);
    try ww.writeAll(",\"full_suite_cmd\":");
    try jsonStr(ww, full_suite_cmd);
    try ww.print(",\"full_suite_done\":{s},\"integration_complete\":{s},\"path_overlaps\":{d}", .{
        if (full_suite_done) "true" else "false",
        if (integration_complete) "true" else "false",
        overlaps_count,
    });

    try ww.writeAll(",\"next_step\":");
    if (can_integrate and next_idx != null) try jsonStr(ww, steps.items[next_idx.?].task_id) else try ww.writeAll("null");

    // cherry_pick_cmd: SOLO el siguiente commit, nunca la ola en bloque.
    if (can_integrate and next_idx != null) {
        const stp = steps.items[next_idx.?];
        try ww.writeAll(",\"cherry_pick_cmd\":");
        try jsonStr(ww, try std.fmt.allocPrint(a, "git -C \"{s}\" cherry-pick {s}", .{ repo_root, stp.commit }));
        try ww.writeAll(",\"after_cherry_pick\":");
        try jsonStr(ww, try std.fmt.allocPrint(a, "Corre step_gate_cmds en {s} sobre el commit resultante y registra agentspipeline(action=\"integration_receipt\", run_id=..., task_id=\"{s}\", head_sha=<git rev-parse HEAD>, gate_exit_code=..., failures=[ids FAILED]). No cherry-pickees el siguiente paso antes de ese recibo.", .{ repo_root, stp.task_id }));
    } else {
        try ww.writeAll(",\"cherry_pick_cmd\":null,\"gate_reason\":");
        if (!integration_authorized) {
            try jsonStr(ww, "Los worktrees aislan cambios pero NO autorizan integracion; inspecciona diff_inspect_cmds y reintenta con integration_authorized=true.");
        } else if (blocked) {
            try jsonStr(ww, try std.fmt.allocPrint(a, "Integracion BLOQUEADA: el ultimo gate de '{s}' dio {s}. Arregla (tarea nueva sobre esa HEAD) y registra un integration_receipt verde para '{s}' antes de seguir.", .{ blocked_by, blocked_verdict, blocked_by }));
        } else if (unfinished_tasks.items.len > 0) {
            try jsonStr(ww, "Hay tareas incompletas en el run_id; resuelve o completa dependencias antes de integrar.");
        } else if (commits.items.len == 0) {
            try jsonStr(ww, "No hay commits registrados para integrar.");
        } else if (!integration_complete and full_suite_cmd.len > 0) {
            try jsonStr(ww, "Todos los pasos tienen gate verde; falta la suite completa: corre full_suite_cmd y registra integration_receipt con task_id=\"full_suite\".");
        } else {
            try jsonStr(ww, "Ola integrada: todos los pasos y la suite completa tienen gate verde.");
        }
    }

    try ww.writeAll(",\"verify_cmds\":");
    try writeJsonStrArray(ww, vcmds);
    try ww.writeAll(",\"gates\":[");
    try jsonStr(ww, "Worktree isolation != autorizacion de integracion; revisar diffs antes de cherry-pick.");
    try ww.writeAll(",");
    try jsonStr(ww, "Integracion SERIAL: un cherry-pick, su gate y su integration_receipt; el verde del worker no cuenta (sus suites no cubren las interacciones con los demas commits).");
    try ww.writeAll(",");
    try jsonStr(ww, "Cada fallo se clasifica contra baseline_failures: pre-existente, nuevo desde el baseline o nuevo en este paso (regresion atribuida al commit recien integrado).");
    try ww.writeAll(",");
    try jsonStr(ww, "Preservar todos los worktrees temporales y archivos no rastreados (nunca ejecutar comandos destructivos sin aprobacion humana).");
    try ww.writeAll("]}");
    return w.written();
}

pub fn runBatonPassJson(a: std.mem.Allocator, env: *const std.process.Environ.Map, args: std.json.ObjectMap, action_name: []const u8) ![]u8 {
    const raw_run_id = strField(args, "run_id") orelse return error.MissingRunId;
    const raw_task_id = strField(args, "task_id") orelse return error.MissingTaskId;
    const task_id = try sanitizeId(a, raw_task_id);
    const previous_terminated = boolField(args, "previous_terminated", false);
    if (!previous_terminated) return error.WorkerStillActive;

    const stall_reason = strField(args, "stall_reason") orelse "worker_terminated_for_handoff";
    const investigated = strField(args, "investigated") orelse strField(args, "context_summary") orelse "";
    const ruled_out = strField(args, "ruled_out") orelse "";
    const modified_files = try readStringArray(a, args, "modified_files");
    const remaining_verify = strField(args, "remaining_verify") orelse "";
    const partial_log_tail = strField(args, "partial_log_tail") orelse "";
    const log_path = strField(args, "log_path") orelse "";
    const steer_instruction = strField(args, "steer_instruction") orelse "";
    const destructive_approved = boolField(args, "destructive_approved", false);

    if (!destructive_approved and steer_instruction.len > 0) {
        if (containsDestructivePattern(steer_instruction) != null) return error.DestructiveCommandBlocked;
    }

    const path = try runFilePath(a, env, raw_run_id);
    const raw = try sys.readFileAlloc(a, path, 4 * 1024 * 1024);
    const parsed = try std.json.parseFromSlice(std.json.Value, a, raw, .{});
    if (parsed.value != .object) return error.InvalidLedger;
    const root_obj = parsed.value.object;
    const tasks_val = root_obj.get("tasks") orelse return error.InvalidLedger;
    if (tasks_val != .array) return error.InvalidLedger;

    const run_id = strField(root_obj, "run_id") orelse raw_run_id;
    const now_ms = sys.realtimeMs();
    var found = false;
    var out_from_agent: []const u8 = "";
    var out_from_model: []const u8 = "";
    var out_to_agent: []const u8 = "";
    var out_to_model: []const u8 = "";
    var out_wt: []const u8 = "";
    var out_launch: []const u8 = "";
    var out_packet: []const u8 = "";
    var out_handoff_count: i64 = 0;

    var lw: Writer.Allocating = .init(a);
    const w = &lw.writer;
    try w.writeAll("{\"run_id\":");
    try jsonStr(w, run_id);
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
            const cur_status = strField(tobj, "status") orelse "pending";
            if (std.mem.eql(u8, cur_status, "completed")) return error.TaskAlreadyCompleted;

            const from_agent = strField(tobj, "agent") orelse "openisy";
            const from_model = strField(tobj, "model") orelse defaultModelForAgent(from_agent);
            const to_agent = strField(args, "fallback_agent") orelse (strField(tobj, "fallback_agent") orelse (if (std.mem.eql(u8, from_agent, "openisy")) "codex" else "claude"));
            const to_model = strField(args, "fallback_model") orelse (if (strField(args, "fallback_agent") == null) (strField(tobj, "fallback_model") orelse defaultModelForAgent(to_agent)) else (if (std.mem.eql(u8, to_agent, "claude")) "sonnet" else defaultModelForAgent(to_agent)));

            const wt_dir = strField(tobj, "worktree_dir") orelse "";
            const title = strField(tobj, "title") orelse tid;
            const orig_prompt = strField(tobj, "prompt") orelse title;
            const verify_cmd = strField(tobj, "verify_cmd") orelse "pytest -q";

            var read_only = false;
            var scope_str: []const u8 = ".";
            if (tobj.get("scope")) |sv| {
                if (sv == .object) {
                    read_only = boolField(sv.object, "read_only", false);
                    const ap = try readStringArray(a, sv.object, "allowed_paths");
                    if (ap.len > 0) scope_str = try std.mem.join(a, ", ", ap);
                }
            }
            const effective_perm = defaultPermForAgent(to_agent, read_only);
            const prev_count = intField(tobj, "handoff_count", 0);
            const new_count = prev_count + 1;

            const mod_files_str = if (modified_files.len > 0) try std.mem.join(a, ", ", modified_files) else "(check git status --short)";
            const baton_packet = try std.fmt.allocPrint(
                a,
                "BATONPASS HANDOFF #{d} | Run {s} | Task {s} ({s}) in worktree {s}.\n" ++
                    "Previous worker: {s}/{s} terminated & fenced ({s}).\n" ++
                    "Scope (preserved, least-privilege): allowed_paths=[{s}] read_only={s} can_integrate=false.\n" ++
                    "Original task: {s}\n" ++
                    "Steer instruction: {s}\n" ++
                    "Technical state — Investigated: {s}\n" ++
                    "Ruled-out hypotheses: {s}\n" ++
                    "Modified files: {s}\n" ++
                    "Remaining to verify: {s}\n" ++
                    "Log path: {s}\n" ++
                    "Partial log tail:\n{s}\n" ++
                    "First inspect `git -C \"{s}\" status --short` and `git -C \"{s}\" diff` to resume cleanly without duplicating ruled-out work. " ++
                    "Verify with: {s}. Do NOT run destructive commands or merge into main; commit only your own files with 'git commit -- <files>' and report exact commit_sha and test output.",
                .{
                    new_count,
                    run_id,
                    tid,
                    title,
                    wt_dir,
                    from_agent,
                    from_model,
                    stall_reason,
                    scope_str,
                    if (read_only) "true" else "false",
                    orig_prompt,
                    if (steer_instruction.len > 0) steer_instruction else "(continue and finish original task)",
                    if (investigated.len > 0) investigated else "(none provided; inspect worktree diff)",
                    if (ruled_out.len > 0) ruled_out else "(none recorded)",
                    mod_files_str,
                    if (remaining_verify.len > 0) remaining_verify else verify_cmd,
                    if (log_path.len > 0) log_path else "(none)",
                    if (partial_log_tail.len > 0) partial_log_tail else "(empty)",
                    wt_dir,
                    wt_dir,
                    verify_cmd,
                },
            );
            const new_launch = try buildLaunchCmd(a, to_agent, to_model, effective_perm, wt_dir, baton_packet);

            out_from_agent = from_agent;
            out_from_model = from_model;
            out_to_agent = to_agent;
            out_to_model = to_model;
            out_wt = wt_dir;
            out_launch = new_launch;
            out_packet = baton_packet;
            out_handoff_count = new_count;

            try w.writeAll("{\"id\":");
            try jsonStr(w, tid);
            try w.writeAll(",\"title\":");
            try jsonStr(w, title);
            try w.writeAll(",\"prompt\":");
            try jsonStr(w, orig_prompt);
            try w.writeAll(",\"agent\":");
            try jsonStr(w, to_agent);
            try w.writeAll(",\"model\":");
            try jsonStr(w, to_model);
            try w.writeAll(",\"fallback_agent\":");
            try jsonStr(w, from_agent);
            try w.writeAll(",\"fallback_model\":");
            try jsonStr(w, from_model);
            try w.writeAll(",\"status\":\"handed_off\"");
            try w.writeAll(",\"depends_on\":");
            if (tobj.get("depends_on")) |dv| try std.json.Stringify.value(dv, .{}, w) else try w.writeAll("[]");
            try w.writeAll(",\"scope\":{\"allowed_paths\":");
            if (tobj.get("scope")) |sv| {
                if (sv == .object) {
                    const ap = try readStringArray(a, sv.object, "allowed_paths");
                    if (ap.len > 0) try writeJsonStrArray(w, ap) else try w.writeAll("[\".\"]");
                } else try w.writeAll("[\".\"]");
            } else try w.writeAll("[\".\"]");
            try w.print(",\"read_only\":{s},\"permission_mode\":", .{if (read_only) "true" else "false"});
            try jsonStr(w, effective_perm);
            try w.writeAll(",\"can_integrate\":false}");
            try w.writeAll(",\"worktree_dir\":");
            try jsonStr(w, wt_dir);
            try w.writeAll(",\"worktree_cmd\":");
            try jsonStr(w, strField(tobj, "worktree_cmd") orelse "");
            try w.writeAll(",\"launch_cmd\":");
            try jsonStr(w, new_launch);
            try w.writeAll(",\"verify_cmd\":");
            try jsonStr(w, verify_cmd);
            try w.print(",\"handoff_count\":{d},\"handoff_history\":[", .{new_count});
            var hist_written = false;
            if (tobj.get("handoff_history")) |hv| {
                if (hv == .array) {
                    for (hv.array.items) |he| {
                        if (hist_written) try w.writeByte(',');
                        try std.json.Stringify.value(he, .{}, w);
                        hist_written = true;
                    }
                }
            }
            if (hist_written) try w.writeByte(',');
            try w.writeAll("{\"from_agent\":");
            try jsonStr(w, from_agent);
            try w.writeAll(",\"from_model\":");
            try jsonStr(w, from_model);
            try w.writeAll(",\"to_agent\":");
            try jsonStr(w, to_agent);
            try w.writeAll(",\"to_model\":");
            try jsonStr(w, to_model);
            try w.writeAll(",\"stall_reason\":");
            try jsonStr(w, stall_reason);
            try w.print(",\"handed_off_at_ms\":{d}}}", .{now_ms});
            try w.writeAll("]");
            try w.writeAll(",\"receipt\":");
            if (tobj.get("receipt")) |rv| try std.json.Stringify.value(rv, .{}, w) else try w.writeAll("null");
            try w.writeByte('}');
        } else {
            try std.json.Stringify.value(item, .{}, w);
        }
    }
    try w.writeAll("]}");
    if (!found) return error.TaskNotFound;

    try sys.writeFile(path, try carryRootExtras(a, root_obj, lw.written()));

    var out: Writer.Allocating = .init(a);
    const ow = &out.writer;
    try ow.writeAll("{\"action\":");
    try jsonStr(ow, action_name);
    try ow.writeAll(",\"run_id\":");
    try jsonStr(ow, run_id);
    try ow.writeAll(",\"task_id\":");
    try jsonStr(ow, task_id);
    try ow.writeAll(",\"from_agent\":");
    try jsonStr(ow, out_from_agent);
    try ow.writeAll(",\"from_model\":");
    try jsonStr(ow, out_from_model);
    try ow.writeAll(",\"to_agent\":");
    try jsonStr(ow, out_to_agent);
    try ow.writeAll(",\"to_model\":");
    try jsonStr(ow, out_to_model);
    try ow.print(",\"handoff_count\":{d}", .{out_handoff_count});
    try ow.writeAll(",\"worktree_dir\":");
    try jsonStr(ow, out_wt);
    try ow.writeAll(",\"launch_cmd\":");
    try jsonStr(ow, out_launch);
    try ow.writeAll(",\"baton_packet\":");
    try jsonStr(ow, out_packet);
    try ow.writeAll(",\"ledger_path\":");
    try jsonStr(ow, path);
    try ow.writeAll(",\"integration_authorized\":false}");
    return out.written();
}

pub fn handleToolCall(a: std.mem.Allocator, env: *const std.process.Environ.Map, args: std.json.ObjectMap) ![]u8 {
    const action = strField(args, "action") orelse "discover";
    if (std.mem.eql(u8, action, "discover")) {
        return try runDiscoverJson(a, env);
    } else if (std.mem.eql(u8, action, "plan")) {
        return try runPlanJson(a, env, args);
    } else if (std.mem.eql(u8, action, "receipt")) {
        return try runReceiptJson(a, env, args);
    } else if (std.mem.eql(u8, action, "batonpass") or std.mem.eql(u8, action, "steer")) {
        return try runBatonPassJson(a, env, args, action);
    } else if (std.mem.eql(u8, action, "status") or std.mem.eql(u8, action, "resume")) {
        return try runStatusJson(a, env, args, action);
    } else if (std.mem.eql(u8, action, "verify")) {
        return try runVerifyJson(a, env, args);
    } else if (std.mem.eql(u8, action, "integration_receipt")) {
        return try runIntegrationReceiptJson(a, env, args);
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

    // 6. BatonPass / Steer hands off stalled task with context & preserved scope, blocks completed/destructive
    const bp_plan =
        \\{"repo_root":"/tmp/demo","base_ref":"HEAD","wave_name":"w13","run_id":"test_run_bp",
        \\"tasks":[
        \\  {"id":"s1","title":"Sweep slicing","agent":"openisy","model":"nvidia/minimaxai/minimax-m3.1-flash","fallback_agent":"codex","fallback_model":"gpt-6-luna","allowed_paths":["tests/test_adv_wave13_slicing_v1.py"],"read_only":false}
        \\]}
    ;
    const bp_plan_parsed = try std.json.parseFromSlice(std.json.Value, aa, bp_plan, .{});
    _ = try runPlanJson(aa, &env, bp_plan_parsed.value.object);

    const bad_steer = try std.json.parseFromSlice(std.json.Value, aa, "{\"run_id\":\"test_run_bp\",\"task_id\":\"s1\",\"previous_terminated\":true,\"steer_instruction\":\"run git reset --hard\"}", .{});
    try std.testing.expectError(error.DestructiveCommandBlocked, runBatonPassJson(aa, &env, bad_steer.value.object, "steer"));

    // Must fail closed if previous worker is not terminated/fenced (never two writers on same worktree)
    const unfenced_bp = try std.json.parseFromSlice(std.json.Value, aa, "{\"run_id\":\"test_run_bp\",\"task_id\":\"s1\",\"investigated\":\"Read corpus\"}", .{});
    try std.testing.expectError(error.WorkerStillActive, runBatonPassJson(aa, &env, unfenced_bp.value.object, "batonpass"));

    const bp_args = try std.json.parseFromSlice(std.json.Value, aa, "{\"run_id\":\"test_run_bp\",\"task_id\":\"s1\",\"previous_terminated\":true,\"stall_reason\":\"terminated_after_review\",\"investigated\":\"Read corpus files\",\"ruled_out\":\"Not a parser bug\",\"modified_files\":[\"tests/test_adv_wave13_slicing_v1.py\"],\"remaining_verify\":\"pytest -q tests/test_adv_wave13_slicing_v1.py\"}", .{});
    const bp_out = try runBatonPassJson(aa, &env, bp_args.value.object, "batonpass");
    try std.testing.expect(std.mem.indexOf(u8, bp_out, "\"to_agent\":\"codex\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, bp_out, "\"to_model\":\"gpt-6-luna\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, bp_out, "\"handoff_count\":1") != null);
    try std.testing.expect(std.mem.indexOf(u8, bp_out, "Not a parser bug") != null);
    try std.testing.expect(std.mem.indexOf(u8, bp_out, "tests/test_adv_wave13_slicing_v1.py") != null);
    try std.testing.expect(std.mem.indexOf(u8, bp_out, "\"integration_authorized\":false") != null);

    // Completed task cannot be handed off
    const done_rec = try std.json.parseFromSlice(std.json.Value, aa, "{\"run_id\":\"test_run_bp\",\"task_id\":\"s1\",\"status\":\"completed\",\"commit_sha\":\"deadbeef\",\"exit_code\":0}", .{});
    _ = try runReceiptJson(aa, &env, done_rec.value.object);
    try std.testing.expectError(error.TaskAlreadyCompleted, runBatonPassJson(aa, &env, bp_args.value.object, "batonpass"));
}

test "pathsOverlap: same file, parent dir, whole repo; siblings do not overlap" {
    try std.testing.expect(pathsOverlap("piton/mir.py", "piton/mir.py"));
    try std.testing.expect(pathsOverlap("piton", "./piton/mir.py"));
    try std.testing.expect(pathsOverlap(".", "tests/x.py"));
    try std.testing.expect(!pathsOverlap("piton/mir.py", "piton/mir.pyc"));
    try std.testing.expect(!pathsOverlap("piton/mir.py", "tests/test_mir.py"));
}

test "serial integration gate: overlaps, verified_on_sha, regression blocks, baseline is not a regression" {
    const a = std.testing.allocator;
    var arena_state = std.heap.ArenaAllocator.init(a);
    defer arena_state.deinit();
    const aa = arena_state.allocator();

    var env: std.process.Environ.Map = .init(aa);
    try env.put("PATH", "/usr/bin:/bin");
    try env.put("ISYMCP_PIPELINE_DIR", "/tmp/isymcp_pipeline_test_gate");

    // Ola con dos tareas paralelas sobre el mismo archivo y una tercera
    // serializada por depends_on (no cuenta como solape).
    const plan_json =
        \\{"repo_root":"/tmp/demo","base_ref":"HEAD","integration_ref":"rescate/wip","wave_name":"w15","run_id":"gate_run",
        \\"baseline_failures":["t::old_a","t::old_b"],"full_suite_cmd":"pytest -q tests/",
        \\"tasks":[
        \\  {"id":"link","agent":"codex","allowed_paths":["piton/mir.py","piton/linux_x86.py"],"verify_cmd":"pytest -q tests/test_p0.py"},
        \\  {"id":"grammar","agent":"codex","allowed_paths":["piton/mir.py"],"verify_cmd":"pytest -q tests/test_grammar.py"},
        \\  {"id":"docs","agent":"claude","allowed_paths":["piton/mir.py"],"depends_on":["grammar"],"verify_cmd":"pytest -q tests/test_grammar.py"}
        \\]}
    ;
    const pp = try std.json.parseFromSlice(std.json.Value, aa, plan_json, .{});
    const plan = try runPlanJson(aa, &env, pp.value.object);
    try std.testing.expect(std.mem.indexOf(u8, plan, "\"path_overlaps\":[{\"tasks\":[\"link\",\"grammar\"]") != null);
    try std.testing.expect(std.mem.indexOf(u8, plan, "\"tasks\":[\"grammar\",\"docs\"]") == null);
    try std.testing.expect(std.mem.indexOf(u8, plan, "overlap_warning") != null);
    try std.testing.expect(std.mem.indexOf(u8, plan, "git rebase rescate/wip") != null);
    // codex con workspace-write puede commitear en su worktree (objects + su gitdir, nada mas).
    try std.testing.expect(std.mem.indexOf(u8, plan, "--add-dir \\\"$(git rev-parse --path-format=absolute --git-common-dir)/objects\\\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, plan, "--add-dir \\\"$(git rev-parse --absolute-git-dir)\\\"") != null);
    // Gate de ola por defecto = unión de los verify_cmd, sin duplicados.
    try std.testing.expect(std.mem.indexOf(u8, plan, "\"integration_gate_cmds\":[\"pytest -q tests/test_p0.py\",\"pytest -q tests/test_grammar.py\"]") != null);

    const recs = [_][]const u8{
        "{\"run_id\":\"gate_run\",\"task_id\":\"grammar\",\"status\":\"completed\",\"commit_sha\":\"edb8a9c0\",\"verified_on_sha\":\"08f1ab20\"}",
        "{\"run_id\":\"gate_run\",\"task_id\":\"link\",\"status\":\"completed\",\"commit_sha\":\"8b743690\"}",
        "{\"run_id\":\"gate_run\",\"task_id\":\"docs\",\"status\":\"completed\",\"commit_sha\":\"d9bff6e0\",\"verified_on_sha\":\"0caf9700\"}",
    };
    for (recs) |r| {
        const rp = try std.json.parseFromSlice(std.json.Value, aa, r, .{});
        _ = try runReceiptJson(aa, &env, rp.value.object);
    }

    // receipt reescribe el ledger: la compuerta de la ola debe sobrevivir.
    const led = try loadLedger(aa, &env, "gate_run");
    try std.testing.expectEqualStrings("rescate/wip", strField(led.root, "integration_ref").?);
    try std.testing.expect(led.root.get("baseline_failures") != null);

    // verify: serial, un solo commit (respetando depends_on), recibos sin base marcados.
    const vp = try std.json.parseFromSlice(std.json.Value, aa, "{\"run_id\":\"gate_run\",\"integration_authorized\":true,\"integration_head\":\"08f1ab20\"}", .{});
    const v1 = try runVerifyJson(aa, &env, vp.value.object);
    try std.testing.expect(std.mem.indexOf(u8, v1, "\"integration_mode\":\"serial\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, v1, "\"next_step\":\"link\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, v1, "cherry-pick 8b743690\",\"after_cherry_pick\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, v1, "cherry-pick 8b743690 ") == null);
    try std.testing.expect(std.mem.indexOf(u8, v1, "{\"task_id\":\"link\",\"verified_on_sha\":\"\",\"reason\":\"missing_verified_on_sha\"}") != null);
    try std.testing.expect(std.mem.indexOf(u8, v1, "{\"task_id\":\"docs\",\"verified_on_sha\":\"0caf9700\",\"reason\":\"base_moved\"}") != null);
    // docs depende de grammar: grammar va antes que docs en integration_steps.
    const gi = std.mem.indexOf(u8, v1, "{\"task_id\":\"grammar\",\"commit\"").?;
    const di = std.mem.indexOf(u8, v1, "{\"task_id\":\"docs\",\"commit\"").?;
    try std.testing.expect(gi < di);

    // Paso 1 (link): solo fallos del baseline -> pass, y baseline arreglado se reporta.
    const ir1 = try std.json.parseFromSlice(std.json.Value, aa, "{\"run_id\":\"gate_run\",\"task_id\":\"link\",\"head_sha\":\"32ee48a0\",\"gate_exit_code\":1,\"failures\":[\"t::old_a\"]}", .{});
    const r1 = try runIntegrationReceiptJson(aa, &env, ir1.value.object);
    try std.testing.expect(std.mem.indexOf(u8, r1, "\"verdict\":\"pass\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, r1, "\"pre_existing\":[\"t::old_a\"]") != null);
    try std.testing.expect(std.mem.indexOf(u8, r1, "\"fixed_vs_baseline\":[\"t::old_b\"]") != null);

    // Paso 2 (grammar): un fallo nuevo -> regresión atribuida a grammar, integración bloqueada.
    const ir2 = try std.json.parseFromSlice(std.json.Value, aa, "{\"run_id\":\"gate_run\",\"task_id\":\"grammar\",\"head_sha\":\"0caf9700\",\"gate_exit_code\":1,\"failures\":[\"t::old_a\",\"t::divmap41\"],\"conflict_resolved\":true}", .{});
    const r2 = try runIntegrationReceiptJson(aa, &env, ir2.value.object);
    try std.testing.expect(std.mem.indexOf(u8, r2, "\"verdict\":\"regression\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, r2, "\"new_this_step\":[\"t::divmap41\"]") != null);
    const v2 = try runVerifyJson(aa, &env, vp.value.object);
    try std.testing.expect(std.mem.indexOf(u8, v2, "\"integration_allowed\":false") != null);
    try std.testing.expect(std.mem.indexOf(u8, v2, "BLOQUEADA") != null);
    try std.testing.expect(std.mem.indexOf(u8, v2, "\"cherry_pick_cmd\":null") != null);

    // Repetir el mismo gate rojo no lo vuelve verde (la referencia es el último gate verde).
    const r2b = try runIntegrationReceiptJson(aa, &env, ir2.value.object);
    try std.testing.expect(std.mem.indexOf(u8, r2b, "\"verdict\":\"regression\"") != null);

    // Fix registrado sobre grammar -> desbloquea; sigue docs.
    const ir3 = try std.json.parseFromSlice(std.json.Value, aa, "{\"run_id\":\"gate_run\",\"task_id\":\"grammar\",\"head_sha\":\"1234abcd\",\"gate_exit_code\":1,\"failures\":[\"t::old_a\"]}", .{});
    const r3 = try runIntegrationReceiptJson(aa, &env, ir3.value.object);
    try std.testing.expect(std.mem.indexOf(u8, r3, "\"verdict\":\"pass\"") != null);
    const v3 = try runVerifyJson(aa, &env, vp.value.object);
    try std.testing.expect(std.mem.indexOf(u8, v3, "\"next_step\":\"docs\"") != null);

    // Gate != 0 sin ids -> no clasificable, bloquea.
    const ir4 = try std.json.parseFromSlice(std.json.Value, aa, "{\"run_id\":\"gate_run\",\"task_id\":\"docs\",\"head_sha\":\"5678abcd\",\"gate_exit_code\":2}", .{});
    const r4 = try runIntegrationReceiptJson(aa, &env, ir4.value.object);
    try std.testing.expect(std.mem.indexOf(u8, r4, "\"verdict\":\"unclassified_failure\"") != null);
    const ir5 = try std.json.parseFromSlice(std.json.Value, aa, "{\"run_id\":\"gate_run\",\"task_id\":\"docs\",\"head_sha\":\"5678abcd\",\"gate_exit_code\":1,\"failures\":[\"t::old_a\"]}", .{});
    _ = try runIntegrationReceiptJson(aa, &env, ir5.value.object);

    // Todos los pasos verdes pero falta la suite completa.
    const v4 = try runVerifyJson(aa, &env, vp.value.object);
    try std.testing.expect(std.mem.indexOf(u8, v4, "\"integration_complete\":false") != null);
    try std.testing.expect(std.mem.indexOf(u8, v4, "falta la suite completa") != null);
    const irf = try std.json.parseFromSlice(std.json.Value, aa, "{\"run_id\":\"gate_run\",\"task_id\":\"full_suite\",\"head_sha\":\"5678abcd\",\"gate_exit_code\":1,\"failures\":[\"t::old_a\"]}", .{});
    _ = try runIntegrationReceiptJson(aa, &env, irf.value.object);
    const v5 = try runVerifyJson(aa, &env, vp.value.object);
    try std.testing.expect(std.mem.indexOf(u8, v5, "\"integration_complete\":true") != null);

    // Tarea inexistente y head_sha ausente fallan cerrado.
    const bad1 = try std.json.parseFromSlice(std.json.Value, aa, "{\"run_id\":\"gate_run\",\"task_id\":\"nope\",\"head_sha\":\"5678abcd\"}", .{});
    try std.testing.expectError(error.TaskNotFound, runIntegrationReceiptJson(aa, &env, bad1.value.object));
    const bad2 = try std.json.parseFromSlice(std.json.Value, aa, "{\"run_id\":\"gate_run\",\"task_id\":\"docs\"}", .{});
    try std.testing.expectError(error.MissingHeadSha, runIntegrationReceiptJson(aa, &env, bad2.value.object));
}
