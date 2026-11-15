//! Conector stdio ⇄ hub: es el único MCP que se registra en cada TUI. Copia bytes entre su
//! stdin/stdout y el socket del daemon con poll(), sin parsear nada. Si el daemon no está, lo
//! levanta desacoplado (setsid) y espera a que escuche.
const std = @import("std");
const linux = std.os.linux;
const sys = @import("sys.zig");

pub const Options = struct {
    socket_path: []const u8,
    autostart: bool,
    wait_ms: u64,
    self_exe: [:0]const u8,
    log_path: []const u8,
    envp: [*:null]const ?[*:0]const u8,
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

pub fn run(opts: Options) !void {
    const sock = connectWithRetry(opts) catch |e| {
        var buf: [1024]u8 = undefined;
        const msg = std.fmt.bufPrint(&buf, "isymcp hub: no se pudo conectar al hub en {s} ({s}); mira {s}\n", .{ opts.socket_path, @errorName(e), opts.log_path }) catch "isymcp hub: no se pudo conectar\n";
        sys.writeAll(2, msg) catch {};
        return e;
    };
    var fds = [_]linux.pollfd{
        .{ .fd = 0, .events = linux.POLL.IN, .revents = 0 },
        .{ .fd = sock, .events = linux.POLL.IN, .revents = 0 },
    };
    var buf: [65536]u8 = undefined;
    var stdin_open = true;
    while (true) {
        if (!stdin_open) fds[0].fd = -1;
        _ = sys.check(linux.poll(&fds, fds.len, -1)) catch continue;
        if (fds[1].revents != 0) {
            const n = sys.read(sock, &buf) catch 0;
            if (n == 0) return; // el hub cerró
            sys.writeAll(1, buf[0..n]) catch return;
        }
        if (stdin_open and fds[0].revents != 0) {
            const n = sys.read(0, &buf) catch 0;
            if (n == 0) {
                // La TUI cerró stdin: cerramos nuestra mitad; el hub libera sus procesos per-client.
                stdin_open = false;
                _ = linux.shutdown(sock, linux.SHUT.WR);
            } else sys.writeAll(sock, buf[0..n]) catch return;
        }
    }
}
