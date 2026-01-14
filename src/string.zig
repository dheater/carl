const std = @import("std");

/// String type that tracks ownership and supports SSO (Small String Optimization)
/// - Literals: No allocation, just a slice
/// - Small strings (≤23 bytes): Stored inline, no allocation
/// - Large strings: Heap allocated
pub const String = union(enum) {
    literal_data: []const u8,
    small: SmallString,
    allocated_data: []const u8,

    const SMALL_CAP = 23; // 24 bytes total with length byte

    const SmallString = struct {
        len: u8,
        data: [SMALL_CAP]u8,

        fn slice(self: *const SmallString) []const u8 {
            return self.data[0..self.len];
        }
    };

    pub fn literal(s: []const u8) String {
        return .{ .literal_data = s };
    }

    pub fn owned(s: []const u8) String {
        return .{ .allocated_data = s };
    }

    pub fn copy(allocator: std.mem.Allocator, s: []const u8) !String {
        if (s.len <= SMALL_CAP) {
            var small: SmallString = undefined;
            small.len = @intCast(s.len);
            @memcpy(small.data[0..s.len], s);
            return .{ .small = small };
        }
        const owned_str = try allocator.dupe(u8, s);
        return .{ .allocated_data = owned_str };
    }

    pub fn slice(self: *const String) []const u8 {
        return switch (self.*) {
            .literal_data => |s| s,
            .small => |*s| s.slice(),
            .allocated_data => |s| s,
        };
    }

    pub fn deinit(self: String, allocator: std.mem.Allocator) void {
        switch (self) {
            .literal_data, .small => {},
            .allocated_data => |s| allocator.free(s),
        }
    }

    pub fn jsonStringify(self: String, jws: anytype) !void {
        try jws.write(self.slice());
    }
};

/// Optional string wrapper
pub const OptionalString = struct {
    inner: ?String,

    pub fn none() OptionalString {
        return .{ .inner = null };
    }

    pub fn literal(s: []const u8) OptionalString {
        return .{ .inner = String.literal(s) };
    }

    pub fn owned(s: []const u8) OptionalString {
        return .{ .inner = String.owned(s) };
    }

    pub fn copy(allocator: std.mem.Allocator, s: []const u8) !OptionalString {
        return .{ .inner = try String.copy(allocator, s) };
    }

    pub fn slice(self: *const OptionalString) ?[]const u8 {
        return if (self.inner) |*s| s.slice() else null;
    }

    pub fn deinit(self: OptionalString, allocator: std.mem.Allocator) void {
        if (self.inner) |s| s.deinit(allocator);
    }

    pub fn jsonStringify(self: OptionalString, jws: anytype) !void {
        if (self.inner) |s| {
            try jws.write(s.slice());
        } else {
            try jws.write(null);
        }
    }
};

test "String - literal" {
    const s = String.literal("hello");
    try std.testing.expectEqualStrings("hello", s.slice());
    s.deinit(std.testing.allocator); // Should be no-op
}

test "String - small string optimization" {
    const s = try String.copy(std.testing.allocator, "short");
    defer s.deinit(std.testing.allocator);
    try std.testing.expectEqualStrings("short", s.slice());
    try std.testing.expect(s == .small);
}

test "String - allocated" {
    const long = "this is a very long string that exceeds the small string capacity";
    const s = try String.copy(std.testing.allocator, long);
    defer s.deinit(std.testing.allocator);
    try std.testing.expectEqualStrings(long, s.slice());
    try std.testing.expect(s == .allocated_data);
}

test "String - owned" {
    const allocator = std.testing.allocator;
    const owned_str = try allocator.dupe(u8, "owned");
    const s = String.owned(owned_str);
    defer s.deinit(allocator);
    try std.testing.expectEqualStrings("owned", s.slice());
}

test "OptionalString - none" {
    const s = OptionalString.none();
    try std.testing.expect(s.slice() == null);
    s.deinit(std.testing.allocator);
}

test "OptionalString - literal" {
    const s = OptionalString.literal("test");
    try std.testing.expectEqualStrings("test", s.slice().?);
    s.deinit(std.testing.allocator);
}
