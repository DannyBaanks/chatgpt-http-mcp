//! Envolturas mínimas de syscalls de Linux con errores de Zig. El hub usa syscalls directas
//! (epoll, signalfd, sockets Unix, fork/execve) para tener un bucle de un solo hilo y memoria
//! predecible, sin runtime de I/O de por medio.
const std = @import("std");
const linux = std.os.linux;

pub const Error = error{ Sys, Again, Intr };

pub fn check(rc: usize) Error!usize {
    return switch (linux.errno(rc)) {
        .SUCCESS => rc,
        .AGAIN => error.Again,
        .INTR => error.Intr,
        else => error.Sys,
    };
}

pub fn errnoOf(rc: usize) linux.E {
    return linux.errno(rc);
}

pub fn close(fd: i32) void {
    _ = linux.close(fd);
}

pub fn nowNs() u64 {
    var ts: linux.timespec = undefined;
    _ = linux.clock_gettime(.MONOTONIC, &ts);
    return @as(u64, @intCast(ts.sec)) * std.time.ns_per_s + @as(u64, @intCast(ts.nsec));
}

pub fn realtimeMs() i64 {
    var ts: linux.timespec = undefined;
    _ = linux.clock_gettime(.REALTIME, &ts);
    return @as(i64, ts.sec) * 1000 + @divTrunc(@as(i64, ts.nsec), 1_000_000);
}

pub fn umask(mask: u32) u32 {
    return @truncate(linux.syscall1(.umask, mask));
}

/// read() que devuelve 0 en EOF, error.Again si no hay datos.
pub fn read(fd: i32, buf: []u8) Error!usize {
    while (true) {
        return check(linux.read(fd, buf.ptr, buf.len)) catch |e| switch (e) {
            error.Intr => continue,
            else => return e,
        };
    }
}

pub fn write(fd: i32, buf: []const u8) Error!usize {
    while (true) {
        return check(linux.write(fd, buf.ptr, buf.len)) catch |e| switch (e) {
            error.Intr => continue,
            else => return e,
        };
    }
}

/// Escritura bloqueante completa (para fds bloqueantes: stdout del conector, logs).
pub fn writeAll(fd: i32, buf: []const u8) Error!void {
    var off: usize = 0;
    while (off < buf.len) off += try write(fd, buf[off..]);
}

pub fn unixAddr(path: []const u8) error{NameTooLong}!linux.sockaddr.un {
    var addr: linux.sockaddr.un = .{ .path = [_]u8{0} ** 108 };
    if (path.len >= addr.path.len) return error.NameTooLong;
    @memcpy(addr.path[0..path.len], path);
    return addr;
}

pub fn connectUnix(path: []const u8, nonblock: bool) !i32 {
    const flags: u32 = linux.SOCK.STREAM | linux.SOCK.CLOEXEC | (if (nonblock) @as(u32, linux.SOCK.NONBLOCK) else 0);
    const fd: i32 = @intCast(try check(linux.socket(linux.AF.UNIX, flags, 0)));
    errdefer close(fd);
    const addr = try unixAddr(path);
    _ = try check(linux.connect(fd, &addr, @sizeOf(linux.sockaddr.un)));
    return fd;
}

pub fn pathZ(buf: []u8, path: []const u8) ![:0]const u8 {
    if (path.len >= buf.len) return error.NameTooLong;
    @memcpy(buf[0..path.len], path);
    buf[path.len] = 0;
    return buf[0..path.len :0];
}

/// Crea la carpeta 0700 si falta y comprueba que sea nuestra y no un enlace.
pub fn ensurePrivateDir(path: []const u8) !void {
    var zb: [4096]u8 = undefined;
    // Crea los padres que falten (como mkdir -p), todos 0700.
    var i: usize = 1;
    while (i <= path.len) : (i += 1) {
        if (i == path.len or path[i] == '/') {
            const z = try pathZ(&zb, path[0..i]);
            const rc = linux.mkdir(z, 0o700);
            switch (linux.errno(rc)) {
                .SUCCESS, .EXIST => {},
                else => return error.MkdirFailed,
            }
        }
    }
    const z = try pathZ(&zb, path);
    var st: linux.Statx = undefined;
    _ = check(linux.statx(linux.AT.FDCWD, z, linux.AT.SYMLINK_NOFOLLOW, .{ .TYPE = true, .MODE = true, .UID = true }, &st)) catch return error.StatFailed;
    if ((st.mode & linux.S.IFMT) != linux.S.IFDIR) return error.NotADirectory;
    if (st.uid != linux.getuid()) return error.WrongOwner;
    _ = check(linux.chmod(z, 0o700)) catch return error.ChmodFailed;
}

pub fn fileMode(path: []const u8) !u32 {
    var zb: [4096]u8 = undefined;
    const z = try pathZ(&zb, path);
    var st: linux.Statx = undefined;
    _ = try check(linux.statx(linux.AT.FDCWD, z, linux.AT.SYMLINK_NOFOLLOW, .{ .MODE = true }, &st));
    return st.mode;
}

pub fn exists(path: []const u8) bool {
    var zb: [4096]u8 = undefined;
    const z = pathZ(&zb, path) catch return false;
    var st: linux.Statx = undefined;
    return linux.errno(linux.statx(linux.AT.FDCWD, z, linux.AT.SYMLINK_NOFOLLOW, .{}, &st)) == .SUCCESS;
}

pub fn unlink(path: []const u8) void {
    var zb: [4096]u8 = undefined;
    const z = pathZ(&zb, path) catch return;
    _ = linux.unlink(z);
}

pub fn rename(old_path: []const u8, new_path: []const u8) !void {
    var ozb: [4096]u8 = undefined;
    var nzb: [4096]u8 = undefined;
    const oz = try pathZ(&ozb, old_path);
    const nz = try pathZ(&nzb, new_path);
    _ = try check(linux.rename(oz, nz));
}

/// Abre (creando) en modo append 0600; devuelve -1 si no se puede.
pub fn openAppend(path: []const u8) i32 {
    var zb: [4096]u8 = undefined;
    const z = pathZ(&zb, path) catch return -1;
    const rc = linux.open(z, .{ .ACCMODE = .WRONLY, .CREAT = true, .APPEND = true, .CLOEXEC = true }, 0o600);
    return if (linux.errno(rc) == .SUCCESS) @intCast(rc) else -1;
}

/// Escribe un archivo completo (truncando) con permisos 0600.
pub fn writeFile(path: []const u8, data: []const u8) !void {
    var zb: [4096]u8 = undefined;
    const z = try pathZ(&zb, path);
    const fd: i32 = @intCast(try check(linux.open(z, .{ .ACCMODE = .WRONLY, .CREAT = true, .TRUNC = true, .CLOEXEC = true }, 0o600)));
    defer close(fd);
    try writeAll(fd, data);
}

pub fn readFileAlloc(gpa: std.mem.Allocator, path: []const u8, max: usize) ![]u8 {
    var zb: [4096]u8 = undefined;
    const z = try pathZ(&zb, path);
    const fd: i32 = @intCast(check(linux.open(z, .{ .ACCMODE = .RDONLY, .CLOEXEC = true }, 0)) catch return error.FileNotFound);
    defer close(fd);
    var list: std.ArrayList(u8) = .empty;
    errdefer list.deinit(gpa);
    var buf: [16384]u8 = undefined;
    while (true) {
        const n = try read(fd, &buf);
        if (n == 0) break;
        if (list.items.len + n > max) return error.FileTooBig;
        try list.appendSlice(gpa, buf[0..n]);
    }
    return list.toOwnedSlice(gpa);
}

pub fn setNonblock(fd: i32) void {
    const fl = linux.fcntl(fd, linux.F.GETFL, 0);
    _ = linux.fcntl(fd, linux.F.SETFL, fl | linux.SOCK.NONBLOCK);
}

pub fn dirname(path: []const u8) []const u8 {
    const i = std.mem.lastIndexOfScalar(u8, path, '/') orelse return ".";
    return if (i == 0) "/" else path[0..i];
}
