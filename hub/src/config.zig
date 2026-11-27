//! servers.json del hub: qué MCP hay detrás y cómo se aíslan. Mismo formato que valida la CLI en
//! TypeScript (src/hub/config.ts), que es quien lo escribe (`isymcp hub import`).
const std = @import("std");
const Value = std.json.Value;

pub const Isolation = enum { shared, per_client };

pub const ServerCfg = struct {
    name: []const u8,
    command: []const u8,
    args: []const []const u8,
    /// pares "CLAVE", "valor"
    env_keys: []const []const u8,
    env_vals: []const []const u8,
    cwd: ?[]const u8,
    isolation: Isolation,
    prewarm: u32,
    max_instances: u32,
    startup_timeout_ms: u64,
    call_timeout_ms: u64,
    /// Tiempo de inactividad tras el cual una instancia ociosa hiberna (0 = nunca hibernar).
    idle_timeout_ms: u64,
    enabled: bool,
    description: ?[]const u8,
    /// mode "direct": el daemon no lo arranca; cada TUI lo lanza tal cual con su propio entorno
    /// (`isymcp-hub connect --direct <nombre>`), para MCP con tokens o datos de sesión de la TUI.
    direct: bool,
    /// JSON canónico de la entrada: si cambia, el reload recrea el servidor.
    fingerprint: []const u8,
};

pub const DEFAULT_PREWARM = 1;
pub const DEFAULT_MAX_INSTANCES = 4;
pub const DEFAULT_STARTUP_TIMEOUT_MS = 120_000;
pub const DEFAULT_CALL_TIMEOUT_MS = 30 * 60_000;
pub const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000;

/// Todo lo devuelto vive en `a` (un arena por servidor o por carga de config).
pub fn parse(a: std.mem.Allocator, text: []const u8) ![]ServerCfg {
    const root = try std.json.parseFromSliceLeaky(Value, a, text, .{});
    if (root != .object) return error.ConfigInvalid;
    const servers = root.object.get("servers") orelse return error.ConfigInvalid;
    if (servers != .object) return error.ConfigInvalid;
    var out: std.ArrayList(ServerCfg) = .empty;
    var it = servers.object.iterator();
    while (it.next()) |kv| {
        const name = kv.key_ptr.*;
        const v = kv.value_ptr.*;
        if (v != .object) return error.ConfigInvalid;
        const o = v.object;
        const command = str(o, "command") orelse return error.ConfigInvalid;
        var args: std.ArrayList([]const u8) = .empty;
        if (o.get("args")) |arr| if (arr == .array) for (arr.array.items) |x| if (x == .string) try args.append(a, x.string);
        var ek: std.ArrayList([]const u8) = .empty;
        var ev: std.ArrayList([]const u8) = .empty;
        if (o.get("env")) |env| if (env == .object) {
            var ei = env.object.iterator();
            while (ei.next()) |e| if (e.value_ptr.* == .string) {
                try ek.append(a, e.key_ptr.*);
                try ev.append(a, e.value_ptr.string);
            };
        };
        const iso = str(o, "isolation") orelse "shared";
        try out.append(a, .{
            .name = name,
            .command = command,
            .args = args.items,
            .env_keys = ek.items,
            .env_vals = ev.items,
            .cwd = str(o, "cwd"),
            .isolation = if (std.mem.eql(u8, iso, "per-client")) .per_client else .shared,
            .prewarm = @intCast(int(o, "prewarm") orelse DEFAULT_PREWARM),
            .max_instances = @intCast(@max(1, int(o, "max_instances") orelse DEFAULT_MAX_INSTANCES)),
            .startup_timeout_ms = @intCast(int(o, "startup_timeout_ms") orelse DEFAULT_STARTUP_TIMEOUT_MS),
            .call_timeout_ms = @intCast(int(o, "call_timeout_ms") orelse DEFAULT_CALL_TIMEOUT_MS),
            .idle_timeout_ms = int(o, "idle_timeout_ms") orelse DEFAULT_IDLE_TIMEOUT_MS,
            .enabled = if (o.get("enabled")) |e| !(e == .bool and !e.bool) else true,
            .description = str(o, "description"),
            .direct = if (str(o, "mode")) |m| std.mem.eql(u8, m, "direct") else false,
            .fingerprint = try std.json.Stringify.valueAlloc(a, v, .{}),
        });
    }
    return out.items;
}

fn str(o: std.json.ObjectMap, k: []const u8) ?[]const u8 {
    const v = o.get(k) orelse return null;
    return if (v == .string) v.string else null;
}

fn int(o: std.json.ObjectMap, k: []const u8) ?u64 {
    const v = o.get(k) orelse return null;
    return if (v == .integer and v.integer >= 0) @intCast(v.integer) else null;
}

/// Lee el opt-in global `auto_reconnect` (nivel raíz de servers.json). Por defecto false.
pub fn parseAutoReconnect(a: std.mem.Allocator, text: []const u8) bool {
    const root = std.json.parseFromSliceLeaky(Value, a, text, .{}) catch return false;
    if (root != .object) return false;
    const v = root.object.get("auto_reconnect") orelse return false;
    return v == .bool and v.bool;
}

test "parse con valores por defecto" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const s = try parse(arena.allocator(),
        \\{"servers":{"a":{"command":"x","args":["y"]},"r":{"command":"rea","isolation":"per-client","enabled":false,"env":{"K":"V"}}}}
    );
    try std.testing.expectEqual(@as(usize, 2), s.len);
    try std.testing.expectEqual(Isolation.shared, s[0].isolation);
    try std.testing.expect(s[0].enabled);
    try std.testing.expectEqual(Isolation.per_client, s[1].isolation);
    try std.testing.expect(!s[1].enabled);
    try std.testing.expectEqualStrings("V", s[1].env_vals[0]);
    try std.testing.expect(!s[0].direct);
}

test "mode direct" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const s = try parse(arena.allocator(), "{\"servers\":{\"m\":{\"command\":\"/usr/bin/mxterm\",\"mode\":\"direct\"}}}");
    try std.testing.expect(s[0].direct);
}

test "idle_timeout_ms: valor por defecto, personalizado y 0 (desactivado)" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const s = try parse(arena.allocator(),
        \\{"servers":{"def":{"command":"x"},"fast":{"command":"x","idle_timeout_ms":5000},"hot":{"command":"x","idle_timeout_ms":0}}}
    );
    try std.testing.expectEqual(@as(usize, 3), s.len);
    for (s) |x| {
        if (std.mem.eql(u8, x.name, "def")) try std.testing.expectEqual(@as(u64, DEFAULT_IDLE_TIMEOUT_MS), x.idle_timeout_ms);
        if (std.mem.eql(u8, x.name, "fast")) try std.testing.expectEqual(@as(u64, 5000), x.idle_timeout_ms);
        if (std.mem.eql(u8, x.name, "hot")) try std.testing.expectEqual(@as(u64, 0), x.idle_timeout_ms);
    }
}

test "parseAutoReconnect: opt-in por defecto false" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    try std.testing.expect(!parseAutoReconnect(a, "{\"servers\":{}}"));
    try std.testing.expect(!parseAutoReconnect(a, "{\"auto_reconnect\":false,\"servers\":{}}"));
    try std.testing.expect(parseAutoReconnect(a, "{\"auto_reconnect\":true,\"servers\":{}}"));
    try std.testing.expect(!parseAutoReconnect(a, "no es json"));
}
