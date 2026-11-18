//! isymcp-hub — daemon de MCP compartidos para todas las TUIs, y su conector stdio.
//!
//!   isymcp-hub serve [--quiet]   daemon (systemd, o lo levanta el conector)
//!   isymcp-hub connect           conector stdio: lo que se registra como MCP en cada TUI
//!   isymcp-hub connect --direct <nombre>   lanza tal cual un MCP con mode "direct" (con el
//!                                entorno de la TUI: tokens y datos de sesión no pasan por el daemon)
//!   isymcp-hub version
//!
//! Rutas (igual que la CLI en TypeScript, src/hub/paths.ts):
//!   servers.json  $ISYMCP_HUB_CONFIG  o  $CODEX_WEB_HTTP_HOME/hub/servers.json  o  ~/.codex-web-http/hub/servers.json
//!   socket        $ISYMCP_HUB_SOCKET  o  $XDG_RUNTIME_DIR/isymcp/hub.sock      o  <hub home>/run/hub.sock
const std = @import("std");
const linux = std.os.linux;
const daemon = @import("daemon.zig");
const connect = @import("connect.zig");
const sys = @import("sys.zig");
const config = @import("config.zig");
const pipeline = @import("pipeline.zig");

test {
    _ = @import("jspan.zig");
    _ = @import("catalog.zig");
    _ = @import("config.zig");
    _ = @import("pipeline.zig");
    _ = @import("daemon.zig");
}

const Paths = struct { home: []const u8, config: []const u8, socket: []const u8 };

fn nonEmpty(env: *const std.process.Environ.Map, k: []const u8) ?[]const u8 {
    const v = std.mem.trim(u8, env.get(k) orelse return null, " \t");
    return if (v.len > 0) v else null;
}

fn resolvePaths(a: std.mem.Allocator, env: *const std.process.Environ.Map) !Paths {
    const bridge = nonEmpty(env, "CODEX_WEB_HTTP_HOME") orelse try std.fmt.allocPrint(a, "{s}/.codex-web-http", .{nonEmpty(env, "HOME") orelse "/tmp"});
    const home = try std.fmt.allocPrint(a, "{s}/hub", .{bridge});
    const cfg = nonEmpty(env, "ISYMCP_HUB_CONFIG") orelse try std.fmt.allocPrint(a, "{s}/servers.json", .{home});
    const sock = nonEmpty(env, "ISYMCP_HUB_SOCKET") orelse blk: {
        if (nonEmpty(env, "XDG_RUNTIME_DIR")) |rt| if (rt[0] == '/') break :blk try std.fmt.allocPrint(a, "{s}/isymcp/hub.sock", .{rt});
        // Muchas TUIs lanzan sus MCP con un entorno saneado, sin XDG_RUNTIME_DIR: sin esto cada una
        // calcularía otra ruta y levantaría un hub duplicado. /run/user/<uid> es la de systemd.
        const fallback = try std.fmt.allocPrint(a, "/run/user/{d}", .{linux.getuid()});
        if (sys.exists(fallback)) break :blk try std.fmt.allocPrint(a, "{s}/isymcp/hub.sock", .{fallback});
        break :blk try std.fmt.allocPrint(a, "{s}/run/hub.sock", .{home});
    };
    return .{ .home = home, .config = cfg, .socket = sock };
}

pub fn main(init: std.process.Init) !void {
    const arena = init.arena.allocator();
    const args = try init.minimal.args.toSlice(arena);
    const cmd: []const u8 = if (args.len > 1) args[1] else "help";
    const paths = try resolvePaths(arena, init.environ_map);
    var quiet = false;
    for (args) |x| if (std.mem.eql(u8, x, "--quiet")) {
        quiet = true;
    };

    if (std.mem.eql(u8, cmd, "serve")) {
        var gpa_state: std.heap.DebugAllocator(.{}) = .init;
        const gpa = if (@import("builtin").mode == .Debug) gpa_state.allocator() else std.heap.smp_allocator;
        var d = daemon.Daemon.init(gpa, init.environ_map, .{
            .socket_path = paths.socket,
            .config_path = paths.config,
            .log_path = if (nonEmpty(init.environ_map, "ISYMCP_HUB_LOG")) |l| (if (std.mem.eql(u8, l, "-")) null else l) else try std.fmt.allocPrint(arena, "{s}/hub.log", .{paths.home}),
            .quiet = quiet,
        });
        d.listen() catch |e| {
            var buf: [512]u8 = undefined;
            sys.writeAll(2, std.fmt.bufPrint(&buf, "isymcp-hub: no arranca: {s}{s}\n", .{ @errorName(e), if (e == error.HubAlreadyRunning) " (ya hay un hub en ese socket)" else if (e == error.NameTooLong) " (la ruta del socket supera 107 bytes; usa ISYMCP_HUB_SOCKET más corta)" else "" }) catch "isymcp-hub: no arranca\n") catch {};
            std.process.exit(if (e == error.HubAlreadyRunning) 3 else 1);
        };
        d.run();
        return;
    }

    if (std.mem.eql(u8, cmd, "connect") and args.len > 3 and std.mem.eql(u8, args[2], "--direct")) {
        // MCP directo: se lanza tal cual con el entorno de la TUI (tokens y datos de sesión no salen
        // de su árbol de procesos) más el env de servers.json; el conector se reemplaza por él.
        const want = args[3];
        const text = sys.readFileAlloc(arena, paths.config, 16 * 1024 * 1024) catch {
            try sys.writeAll(2, "isymcp-hub: no se pudo leer servers.json\n");
            std.process.exit(1);
        };
        const servers = config.parse(arena, text) catch {
            try sys.writeAll(2, "isymcp-hub: servers.json no válido\n");
            std.process.exit(1);
        };
        const s = for (servers) |x| {
            if (std.mem.eql(u8, x.name, want)) break x;
        } else {
            var b: [512]u8 = undefined;
            try sys.writeAll(2, std.fmt.bufPrint(&b, "isymcp-hub: no hay un servidor '{s}' en servers.json\n", .{want}) catch "isymcp-hub: servidor desconocido\n");
            std.process.exit(1);
        };
        if (!s.direct) {
            var b: [512]u8 = undefined;
            try sys.writeAll(2, std.fmt.bufPrint(&b, "isymcp-hub: '{s}' no tiene mode \"direct\"; úsalo por el hub (isymcp-hub connect)\n", .{want}) catch "isymcp-hub: no es directo\n");
            std.process.exit(1);
        }
        var envl: std.ArrayList(?[*:0]const u8) = .empty;
        var path_env: []const u8 = "/usr/local/bin:/usr/bin:/bin";
        for (init.environ_map.keys(), init.environ_map.values()) |k, v| {
            var overridden = false;
            for (s.env_keys) |ck| if (std.mem.eql(u8, ck, k)) {
                overridden = true;
            };
            if (overridden) continue;
            if (std.mem.eql(u8, k, "PATH")) path_env = v;
            try envl.append(arena, try std.fmt.allocPrintSentinel(arena, "{s}={s}", .{ k, v }, 0));
        }
        for (s.env_keys, s.env_vals) |k, v| {
            if (std.mem.eql(u8, k, "PATH")) path_env = v;
            try envl.append(arena, try std.fmt.allocPrintSentinel(arena, "{s}={s}", .{ k, v }, 0));
        }
        try envl.append(arena, null);
        var argv: std.ArrayList(?[*:0]const u8) = .empty;
        try argv.append(arena, try arena.dupeZ(u8, s.command));
        for (s.args) |x| try argv.append(arena, try arena.dupeZ(u8, x));
        try argv.append(arena, null);
        const exe = daemon.Daemon.resolveExe(arena, s.command, path_env) catch {
            var b: [512]u8 = undefined;
            try sys.writeAll(2, std.fmt.bufPrint(&b, "isymcp-hub: no se encuentra el comando '{s}'\n", .{s.command}) catch "isymcp-hub: comando no encontrado\n");
            std.process.exit(127);
        };
        if (s.cwd) |cwd| _ = linux.chdir(try arena.dupeZ(u8, cwd));
        _ = linux.execve(exe, @ptrCast(argv.items.ptr), @ptrCast(envl.items.ptr));
        try sys.writeAll(2, "isymcp-hub: execve falló\n");
        std.process.exit(127);
    }

    if (std.mem.eql(u8, cmd, "connect")) {
        var exe_buf: [4096]u8 = undefined;
        const rl = linux.readlink("/proc/self/exe", &exe_buf, exe_buf.len - 1);
        if (linux.errno(rl) != .SUCCESS) return error.SelfExeUnknown;
        exe_buf[rl] = 0;
        const wait_ms: u64 = if (nonEmpty(init.environ_map, "ISYMCP_HUB_CONNECT_WAIT_MS")) |w| std.fmt.parseInt(u64, w, 10) catch 20_000 else 20_000;
        try sys.ensurePrivateDir(paths.home);
        // envp para el daemon autoarrancado: el mismo entorno que recibió el conector.
        var envl: std.ArrayList(?[*:0]const u8) = .empty;
        for (init.environ_map.keys(), init.environ_map.values()) |k, v| try envl.append(arena, try std.fmt.allocPrintSentinel(arena, "{s}={s}", .{ k, v }, 0));
        try envl.append(arena, null);
        connect.run(.{
            .socket_path = paths.socket,
            .autostart = !std.mem.eql(u8, nonEmpty(init.environ_map, "ISYMCP_HUB_NO_AUTOSTART") orelse "0", "1"),
            .wait_ms = wait_ms,
            .self_exe = exe_buf[0..rl :0],
            .log_path = try std.fmt.allocPrint(arena, "{s}/hub.autostart.log", .{paths.home}),
            .envp = @ptrCast(envl.items.ptr),
        }) catch std.process.exit(1);
        return;
    }

    if (std.mem.eql(u8, cmd, "agentspipeline")) {
        try pipeline.runCli(arena, init.environ_map, args[2..]);
        return;
    }

    if (std.mem.eql(u8, cmd, "version")) {
        try sys.writeAll(1, "isymcp-hub " ++ daemon.VERSION ++ "\n");
        return;
    }

    try sys.writeAll(2,
        \\isymcp-hub serve [--quiet]   daemon de MCP compartidos
        \\isymcp-hub connect           conector stdio para registrar en cada TUI
        \\isymcp-hub connect --direct <nombre>   MCP con mode "direct", tal cual
        \\isymcp-hub agentspipeline [--discover | status <run_id>]   orquestador dinámico multi-agente
        \\isymcp-hub version
        \\
    );
    std.process.exit(2);
}
