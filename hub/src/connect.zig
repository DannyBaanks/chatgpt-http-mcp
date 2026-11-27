//! Conector stdio ⇄ hub: es el único MCP que se registra en cada TUI. Copia bytes entre su
//! stdin/stdout y el socket del daemon con poll(), sin parsear nada. Si el daemon no está, lo
//! levanta desacoplado (setsid) y espera a que escuche.
//!
//! Con `auto_reconnect = true` (opt-in vía `ISYMCP_HUB_AUTO_RECONNECT=1`, `--auto-reconnect` o
//! `"auto_reconnect": true` en servers.json), memoriza el `initialize` inicial de la TUI y, si el
//! daemon se reinicia y cierra el socket, reconecta y reenvía el handshake en silencio sin cortar
//! la sesión de la TUI.
const std = @import("std");
const linux = std.os.linux;
const sys = @import("sys.zig");
const jspan = @import("jspan.zig");

pub const Options = struct {
    socket_path: []const u8,
    autostart: bool,
    auto_reconnect: bool = false,
    wait_ms: u64,
    self_exe: [:0]const u8,
    log_path: []const u8,
    envp: [*:null]const ?[*:0]const u8,
};

const MAX_HANDSHAKE_LINE = 64 * 1024;

const HandshakeCapture = struct {
    gpa: std.mem.Allocator,
    buf: std.ArrayList(u8) = .empty,
    init_line: ?[]u8 = null,
    saw_initialized: bool = false,

    fn deinit(self: *HandshakeCapture) void {
        self.buf.deinit(self.gpa);
        if (self.init_line) |x| self.gpa.free(x);
    }

    fn done(self: *const HandshakeCapture) bool {
        return self.init_line != null and self.saw_initialized;
    }

    fn feed(self: *HandshakeCapture, chunk: []const u8) void {
        if (self.done()) return;
        if (self.buf.items.len + chunk.len > MAX_HANDSHAKE_LINE) {
            self.buf.clearRetainingCapacity();
            return;
        }
        self.buf.appendSlice(self.gpa, chunk) catch return;
        var start: usize = 0;
        while (std.mem.indexOfScalarPos(u8, self.buf.items, start, '\n')) |nl| {
            const line = std.mem.trim(u8, self.buf.items[start..nl], " \r\t");
            start = nl + 1;
            if (line.len == 0) continue;
            var arena = std.heap.ArenaAllocator.init(self.gpa);
            defer arena.deinit();
            const top = jspan.scanTop(arena.allocator(), line) catch continue;
            if (self.init_line == null and top.isRequest() and std.mem.eql(u8, top.methodName(), "initialize")) {
                self.init_line = std.fmt.allocPrint(self.gpa, "{s}\n", .{line}) catch null;
            } else if (!self.saw_initialized and top.isNotification() and std.mem.eql(u8, top.methodName(), "notifications/initialized")) {
                self.saw_initialized = true;
            }
            if (self.done()) break;
        }
        if (self.done()) {
            self.buf.clearAndFree(self.gpa);
        } else if (start > 0) {
            std.mem.copyForwards(u8, self.buf.items, self.buf.items[start..]);
            self.buf.shrinkRetainingCapacity(self.buf.items.len - start);
        }
    }
};

fn startDaemon(opts: Options) void {
    const rc = linux.fork();
    if (linux.errno(rc) != .SUCCESS) return;
    if (rc != 0) {
        var st: u32 = 0;
        _ = linux.waitpid(@intCast(rc), &st, 0); // el intermedio sale enseguida
        return;
    }
    // Intermedio: nueva sesión y doble fork para que el daemon no sea hijo de la TUI.
    _ = linux.setsid();
    const rc2 = linux.fork();
    if (rc2 != 0) linux.exit_group(0);
    var zb: [4096]u8 = undefined;
    const lz = sys.pathZ(&zb, opts.log_path) catch linux.exit_group(1);
    const out = linux.open(lz, .{ .ACCMODE = .WRONLY, .CREAT = true, .APPEND = true }, 0o600);
    const devnull = linux.open("/dev/null", .{ .ACCMODE = .RDONLY }, 0);
    if (linux.errno(devnull) == .SUCCESS) _ = linux.dup2(@intCast(devnull), 0);
    if (linux.errno(out) == .SUCCESS) {
        _ = linux.dup2(@intCast(out), 1);
        _ = linux.dup2(@intCast(out), 2);
    }
    const argv = [_:null]?[*:0]const u8{ opts.self_exe, "serve", "--quiet", null };
    _ = linux.execve(opts.self_exe, &argv, opts.envp);
    linux.exit_group(127);
}

fn connectWithRetry(opts: Options) !i32 {
    if (sys.connectUnix(opts.socket_path, false)) |fd| return fd else |_| {}
    if (!opts.autostart or opts.wait_ms == 0) return error.HubNotRunning;
    startDaemon(opts);
    const deadline = sys.nowNs() + opts.wait_ms * std.time.ns_per_ms;
    while (sys.nowNs() < deadline) {
        var ts = linux.timespec{ .sec = 0, .nsec = 100 * std.time.ns_per_ms };
        _ = linux.nanosleep(&ts, null);
        if (sys.connectUnix(opts.socket_path, false)) |fd| return fd else |_| {}
    }
    return error.HubNotRunning;
}

/// Espera a que el socket del daemon vuelva tras un reinicio (sin depender de autostart si systemd
/// lo levanta), reenvía el `initialize` guardado y consume su respuesta para no duplicarla a la TUI.
/// Si el daemon saliente todavía tenía el socket en cola y cierra durante el handshake, reintenta
/// dentro del plazo hasta completar el handshake con el nuevo daemon.
fn reconnectAndHandshake(opts: Options, cap: *const HandshakeCapture) !i32 {
    const budget_ms = if (opts.wait_ms > 0) opts.wait_ms else 20_000;
    const deadline = sys.nowNs() + budget_ms * std.time.ns_per_ms;
    const autostart_after = sys.nowNs() + 500 * std.time.ns_per_ms;
    var spawned = false;
    while (sys.nowNs() < deadline) {
        if (sys.connectUnix(opts.socket_path, false)) |fd| {
            if (replayHandshake(fd, cap)) {
                return fd;
            } else |_| {
                sys.close(fd);
            }
        } else |_| {}
        if (opts.autostart and !spawned and sys.nowNs() >= autostart_after) {
            spawned = true;
            startDaemon(opts);
        }
        var ts = linux.timespec{ .sec = 0, .nsec = 100 * std.time.ns_per_ms };
        _ = linux.nanosleep(&ts, null);
    }
    return error.HubNotRunning;
}

fn replayHandshake(fd: i32, cap: *const HandshakeCapture) !void {
    const init_line = cap.init_line orelse return;
    try sys.writeAll(fd, init_line);
    // Descarta exactamente la primera línea de respuesta (initialize) para no duplicarla a la TUI.
    var pfd = [_]linux.pollfd{.{ .fd = fd, .events = linux.POLL.IN, .revents = 0 }};
    const hs_deadline = sys.nowNs() + 5 * std.time.ns_per_s;
    var byte: [1]u8 = undefined;
    var got_nl = false;
    while (!got_nl and sys.nowNs() < hs_deadline) {
        const rem_ns = hs_deadline - sys.nowNs();
        const rem_ms: i32 = @intCast(@min(rem_ns / std.time.ns_per_ms + 1, 5000));
        const prc = sys.check(linux.poll(&pfd, 1, rem_ms)) catch continue;
        if (prc == 0) break;
        const n = sys.read(fd, &byte) catch return error.Sys;
        if (n == 0) return error.Sys;
        if (byte[0] == '\n') got_nl = true;
    }
    if (!got_nl) return error.Sys;
    if (cap.saw_initialized) {
        try sys.writeAll(fd, "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n");
    }
}

pub fn run(opts: Options) !void {
    // Evita que SIGPIPE mate el conector si el daemon cierra el socket justo al escribir.
    var mask = linux.sigemptyset();
    linux.sigaddset(&mask, .PIPE);
    _ = linux.sigprocmask(linux.SIG.BLOCK, &mask, null);

    var sock = connectWithRetry(opts) catch |e| {
        var buf: [1024]u8 = undefined;
        const msg = std.fmt.bufPrint(&buf, "isymcp hub: no se pudo conectar al hub en {s} ({s}); mira {s}\n", .{ opts.socket_path, @errorName(e), opts.log_path }) catch "isymcp hub: no se pudo conectar\n";
        sys.writeAll(2, msg) catch {};
        return e;
    };
    defer sys.close(sock);

    var cap: HandshakeCapture = .{ .gpa = std.heap.page_allocator };
    defer cap.deinit();

    var fds = [_]linux.pollfd{
        .{ .fd = 0, .events = linux.POLL.IN, .revents = 0 },
        .{ .fd = sock, .events = linux.POLL.IN, .revents = 0 },
    };
    var buf: [65536]u8 = undefined;
    var stdin_open = true;
    while (true) {
        fds[0].fd = if (stdin_open) 0 else -1;
        fds[1].fd = sock;
        _ = sys.check(linux.poll(&fds, fds.len, -1)) catch continue;
        if (fds[1].revents != 0) {
            const n = sys.read(sock, &buf) catch 0;
            if (n == 0) {
                if (!opts.auto_reconnect or !stdin_open) return;
                sys.close(sock);
                sock = reconnectAndHandshake(opts, &cap) catch return;
                continue;
            }
            sys.writeAll(1, buf[0..n]) catch return;
        }
        if (stdin_open and fds[0].revents != 0) {
            const n = sys.read(0, &buf) catch 0;
            if (n == 0) {
                // La TUI cerró stdin: cerramos nuestra mitad; el hub libera sus procesos per-client.
                stdin_open = false;
                _ = linux.shutdown(sock, linux.SHUT.WR);
            } else {
                if (opts.auto_reconnect and !cap.done()) cap.feed(buf[0..n]);
                sys.writeAll(sock, buf[0..n]) catch {
                    if (!opts.auto_reconnect) return;
                    sys.close(sock);
                    sock = reconnectAndHandshake(opts, &cap) catch return;
                    sys.writeAll(sock, buf[0..n]) catch return;
                };
            }
        }
    }
}

test "HandshakeCapture captura initialize y notifications/initialized en chunks partidos" {
    var cap: HandshakeCapture = .{ .gpa = std.testing.allocator };
    defer cap.deinit();
    cap.feed("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"init");
    try std.testing.expect(cap.init_line == null);
    cap.feed("ialize\",\"params\":{\"protocolVersion\":\"2025-06-18\"}}\n");
    try std.testing.expect(cap.init_line != null);
    try std.testing.expect(!cap.saw_initialized);
    cap.feed("{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"ping\"}\n");
    try std.testing.expect(cap.saw_initialized);
    try std.testing.expect(cap.done());
    try std.testing.expectEqualStrings("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-06-18\"}}\n", cap.init_line.?);
}
