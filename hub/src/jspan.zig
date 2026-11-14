//! Escáner de nivel superior para mensajes JSON-RPC: ubica `id`, `method`, `params`, `result` y
//! `error` como rebanadas del mensaje original, sin construir un árbol. Así el hub reenvía
//! respuestas de varios MB (p. ej. un catálogo o un decompilado) copiando bytes, no objetos.
const std = @import("std");

pub const Top = struct {
    id: ?[]const u8 = null,
    method: ?[]const u8 = null, // span crudo, con comillas
    params: ?[]const u8 = null,
    result: ?[]const u8 = null,
    err: ?[]const u8 = null,

    pub fn isRequest(t: Top) bool {
        return t.method != null and t.id != null;
    }
    pub fn isNotification(t: Top) bool {
        return t.method != null and t.id == null;
    }
    pub fn isResponse(t: Top) bool {
        return t.method == null and t.id != null and (t.result != null or t.err != null);
    }
    /// Nombre del método sin comillas (los métodos MCP no llevan escapes).
    pub fn methodName(t: Top) []const u8 {
        const m = t.method orelse return "";
        return if (m.len >= 2) m[1 .. m.len - 1] else m;
    }
};

pub fn scanTop(scratch: std.mem.Allocator, msg: []const u8) !Top {
    var sc = std.json.Scanner.initCompleteInput(scratch, msg);
    defer sc.deinit();
    if (try sc.next() != .object_begin) return error.NotAnObject;
    var top: Top = .{};
    while (true) {
        const tok = try sc.next();
        const key: []const u8 = switch (tok) {
            .object_end => break,
            .string => |s| s,
            .allocated_string => |s| s,
            else => return error.SyntaxError,
        };
        _ = try sc.peekNextTokenType();
        const start = sc.cursor;
        try sc.skipValue();
        const span = msg[start..sc.cursor];
        if (std.mem.eql(u8, key, "id")) top.id = span else if (std.mem.eql(u8, key, "method")) top.method = span else if (std.mem.eql(u8, key, "params")) top.params = span else if (std.mem.eql(u8, key, "result")) top.result = span else if (std.mem.eql(u8, key, "error")) top.err = span;
    }
    return top;
}

test "scanTop ubica spans crudos" {
    const msg =
        \\ {"jsonrpc":"2.0", "id" : 7, "result": {"content":[{"type":"text","text":"a\"b"}]} }
    ;
    const t = try scanTop(std.testing.allocator, msg);
    try std.testing.expectEqualStrings("7", t.id.?);
    try std.testing.expectEqualStrings("{\"content\":[{\"type\":\"text\",\"text\":\"a\\\"b\"}]}", t.result.?);
    try std.testing.expect(t.isResponse());
}

test "scanTop notificación y request con id string" {
    const n = try scanTop(std.testing.allocator, "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\",\"params\":{\"progress\":1}}");
    try std.testing.expect(n.isNotification());
    try std.testing.expectEqualStrings("notifications/progress", n.methodName());
    const r = try scanTop(std.testing.allocator, "{\"id\":\"abc\",\"method\":\"ping\"}");
    try std.testing.expect(r.isRequest());
    try std.testing.expectEqualStrings("\"abc\"", r.id.?);
}
