//! isymcp-hub — daemon de MCP compartidos para todas las TUIs, y su conector stdio.
//!
//!   isymcp-hub serve [--quiet]   daemon (systemd, o lo levanta el conector)
//!   isymcp-hub connect           conector stdio: lo que se registra como MCP en cada TUI
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

test {
    _ = @import("jspan.zig");
    _ = @import("catalog.zig");
    _ = @import("config.zig");
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

    if (std.mem.eql(u8, cmd, "version")) {
        try sys.writeAll(1, "isymcp-hub " ++ daemon.VERSION ++ "\n");
        return;
    }

    try sys.writeAll(2,
        \\isymcp-hub serve [--quiet]   daemon de MCP compartidos
        \\isymcp-hub connect           conector stdio para registrar en cada TUI
        \\isymcp-hub version
        \\
    );
    std.process.exit(2);
}
