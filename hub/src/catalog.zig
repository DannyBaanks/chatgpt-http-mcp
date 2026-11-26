//! Catálogo de tools de un MCP: se parsea una vez (tools/list) y se guarda compacto en un arena
//! propio: un buffer con el JSON de cada tool más un índice (nombre, descripción corta, pistas).
//! El árbol JSON temporal se libera al terminar, así que el tamaño en reposo es estable.
const std = @import("std");
const Value = std.json.Value;

pub const Entry = struct {
    name: []const u8,
    short: []const u8,
    read_only: bool,
    destructive: bool,
    /// Texto para buscar: título + descripción, en minúsculas.
    haystack: []const u8,
    /// Definición completa de la tool, JSON.
    json: []const u8,
    /// Definición sin `outputSchema` (comparte buffer con `json` si no tenía `outputSchema`).
    json_input: []const u8,
    has_output_schema: bool,
};

pub const Catalog = struct {
    arena: std.heap.ArenaAllocator,
    entries: []Entry = &.{},

    pub fn init(gpa: std.mem.Allocator) Catalog {
        return .{ .arena = std.heap.ArenaAllocator.init(gpa) };
    }

    pub fn deinit(self: *Catalog) void {
        self.arena.deinit();
    }

    pub fn find(self: *const Catalog, name: []const u8) ?*const Entry {
        for (self.entries) |*e| if (std.mem.eql(u8, e.name, name)) return e;
        return null;
    }

    /// Construye el catálogo con las tools (arrays de varias páginas ya concatenadas).
    pub fn build(gpa: std.mem.Allocator, tools: []const Value) !Catalog {
        var cat = Catalog.init(gpa);
        errdefer cat.deinit();
        const a = cat.arena.allocator();
        var list: std.ArrayList(Entry) = .empty;
        for (tools) |t| {
            if (t != .object) continue;
            const name = switch (t.object.get("name") orelse continue) {
                .string => |s| s,
                else => continue,
            };
            const desc: []const u8 = if (t.object.get("description")) |d| (if (d == .string) d.string else "") else "";
            const title: []const u8 = if (t.object.get("title")) |d| (if (d == .string) d.string else "") else "";
            var ro = false;
            var de = false;
            if (t.object.get("annotations")) |ann| if (ann == .object) {
                if (ann.object.get("readOnlyHint")) |v| ro = v == .bool and v.bool;
                if (ann.object.get("destructiveHint")) |v| de = v == .bool and v.bool;
            };
            const hay = try std.ascii.allocLowerString(a, try std.mem.concat(a, u8, &.{ title, " ", desc }));
            const json = try std.json.Stringify.valueAlloc(a, t, .{});
            const has_output = t.object.get("outputSchema") != null;
            const json_input = if (has_output) try stringifyWithoutOutputSchema(a, t.object) else json;
            try list.append(a, .{
                .name = try a.dupe(u8, name),
                .short = try firstSentence(a, desc, 200),
                .read_only = ro,
                .destructive = de,
                .haystack = hay,
                .json = json,
                .json_input = json_input,
                .has_output_schema = has_output,
            });
        }
        cat.entries = try list.toOwnedSlice(a);
        return cat;
    }
};

fn stringifyWithoutOutputSchema(a: std.mem.Allocator, obj: std.json.ObjectMap) ![]const u8 {
    var w: std.Io.Writer.Allocating = .init(a);
    var s: std.json.Stringify = .{ .writer = &w.writer };
    try s.beginObject();
    var it = obj.iterator();
    while (it.next()) |kv| {
        if (std.mem.eql(u8, kv.key_ptr.*, "outputSchema")) continue;
        try s.objectField(kv.key_ptr.*);
        try s.write(kv.value_ptr.*);
    }
    try s.endObject();
    return w.written();
}

/// Primera frase (o los primeros `max` bytes) con espacios aplanados; "…" si se recortó.
pub fn firstSentence(a: std.mem.Allocator, text: []const u8, max: usize) ![]const u8 {
    var flat: std.ArrayList(u8) = .empty;
    var space = false;
    for (std.mem.trim(u8, text, " \t\r\n")) |c| {
        if (c == ' ' or c == '\t' or c == '\r' or c == '\n') {
            space = true;
        } else {
            if (space and flat.items.len > 0) try flat.append(a, ' ');
            space = false;
            try flat.append(a, c);
        }
    }
    const s = flat.items;
    var cut: ?usize = null;
    var i: usize = 0;
    while (i + 1 < s.len) : (i += 1) {
        if ((s[i] == '.' or s[i] == '!' or s[i] == '?') and s[i + 1] == ' ') {
            cut = i + 1;
            break;
        }
    }
    var end: usize = if (cut) |c| (if (c < max) c else max) else @min(s.len, max);
    while (end < s.len and end > 0 and (s[end] & 0xC0) == 0x80) end -= 1; // no partir un carácter UTF-8
    if (end < s.len and !(end > 0 and (s[end - 1] == '.' or s[end - 1] == '!' or s[end - 1] == '?'))) {
        return std.mem.concat(a, u8, &.{ s[0..end], "…" });
    }
    return a.dupe(u8, s[0..end]);
}

pub const Hit = struct { server: []const u8, entry: *const Entry, score: u32 };

/// Busca términos en nombre (pesa más) y descripción. Exige al menos un punto por término.
pub fn search(a: std.mem.Allocator, out: *std.ArrayList(Hit), server: []const u8, cat: *const Catalog, query: []const u8) !void {
    var terms: std.ArrayList([]const u8) = .empty;
    var it = std.mem.tokenizeAny(u8, query, " \t_-.,");
    while (it.next()) |t| try terms.append(a, try std.ascii.allocLowerString(a, t));
    if (terms.items.len == 0) return;
    for (cat.entries) |*e| {
        const name = try std.ascii.allocLowerString(a, e.name);
        var score: u32 = 0;
        for (terms.items) |term| {
            if (std.mem.eql(u8, name, term)) score += 10 else if (std.mem.indexOf(u8, name, term) != null) score += 5;
            if (std.mem.indexOf(u8, e.haystack, term) != null) score += 1;
        }
        if (score >= terms.items.len) try out.append(a, .{ .server = server, .entry = e, .score = score });
    }
}

pub fn sortHits(hits: []Hit) void {
    std.mem.sort(Hit, hits, {}, struct {
        fn lt(_: void, x: Hit, y: Hit) bool {
            if (x.score != y.score) return x.score > y.score;
            return std.mem.lessThan(u8, x.entry.name, y.entry.name);
        }
    }.lt);
}

/// Hasta `n` nombres parecidos: subcadena primero, luego distancia de edición.
pub fn suggest(a: std.mem.Allocator, name: []const u8, candidates: []const []const u8, n: usize) ![]const []const u8 {
    const Scored = struct { c: []const u8, s: usize };
    var scored: std.ArrayList(Scored) = .empty;
    const q = try std.ascii.allocLowerString(a, name);
    for (candidates) |c| {
        const l = try std.ascii.allocLowerString(a, c);
        const s = if (std.mem.indexOf(u8, l, q) != null or std.mem.indexOf(u8, q, l) != null) 0 else try editDistance(a, q, l);
        try scored.append(a, .{ .c = c, .s = s });
    }
    std.mem.sort(Scored, scored.items, {}, struct {
        fn lt(_: void, x: Scored, y: Scored) bool {
            return x.s < y.s;
        }
    }.lt);
    const limit = @max(@as(usize, 3), q.len / 2);
    var out: std.ArrayList([]const u8) = .empty;
    for (scored.items) |x| {
        if (out.items.len >= n) break;
        if (x.s <= limit) try out.append(a, x.c);
    }
    return out.items;
}

fn editDistance(a: std.mem.Allocator, x: []const u8, y: []const u8) !usize {
    const dp = try a.alloc(usize, y.len + 1);
    for (dp, 0..) |*d, j| d.* = j;
    for (x, 1..) |cx, i| {
        var prev = dp[0];
        dp[0] = i;
        for (y, 1..) |cy, j| {
            const tmp = dp[j];
            dp[j] = @min(@min(dp[j] + 1, dp[j - 1] + 1), prev + @intFromBool(cx != cy));
            prev = tmp;
        }
    }
    return dp[y.len];
}

test "firstSentence corta en la primera frase" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    try std.testing.expectEqualStrings("Devuelve el texto.", try firstSentence(a, "Devuelve el texto.  Segunda\nfrase.", 200));
    try std.testing.expectEqualStrings("abc…", try firstSentence(a, "abcdef", 3));
    try std.testing.expectEqualStrings("", try firstSentence(a, "", 200));
}

test "búsqueda: nombre pesa más; sugerencias por parecido" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const parsed = try std.json.parseFromSliceLeaky(Value, a,
        \\[{"name":"open_binary","description":"Open a file"},{"name":"list_strings","description":"Strings from an open binary"}]
    , .{});
    var cat = try Catalog.build(std.testing.allocator, parsed.array.items);
    defer cat.deinit();
    var hits: std.ArrayList(Hit) = .empty;
    try search(a, &hits, "rea", &cat, "binary");
    sortHits(hits.items);
    try std.testing.expectEqual(@as(usize, 2), hits.items.len);
    try std.testing.expectEqualStrings("open_binary", hits.items[0].entry.name);
    const s = try suggest(a, "open_binry", &.{ "open_binary", "close_binary", "xrefs" }, 5);
    try std.testing.expectEqualStrings("open_binary", s[0]);
}

test "Catalog.build separa json_input sin outputSchema y reutiliza slice si no existe" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const parsed = try std.json.parseFromSliceLeaky(Value, a,
        \\[{"name":"plain","description":"No output","inputSchema":{"type":"object"}},{"name":"heavy","description":"With output","inputSchema":{"type":"object","properties":{"x":{"type":"string"}}},"outputSchema":{"type":"object","properties":{"big":{"type":"string"}}}}]
    , .{});
    var cat = try Catalog.build(std.testing.allocator, parsed.array.items);
    defer cat.deinit();

    const plain = cat.find("plain").?;
    try std.testing.expect(!plain.has_output_schema);
    try std.testing.expectEqual(plain.json.ptr, plain.json_input.ptr);

    const heavy = cat.find("heavy").?;
    try std.testing.expect(heavy.has_output_schema);
    try std.testing.expect(std.mem.indexOf(u8, heavy.json, "\"outputSchema\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, heavy.json_input, "\"outputSchema\"") == null);
    try std.testing.expect(std.mem.indexOf(u8, heavy.json_input, "\"inputSchema\"") != null);
}
