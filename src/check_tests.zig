const std = @import("std");
const CheckResult = @import("main.zig").CheckResult;
const String = @import("string.zig").String;
const OptionalString = @import("string.zig").OptionalString;

const TEST_PATTERNS = [_][]const u8{
    "test.cpp",
    "Test.cpp",
    "_test.cpp",
    "test.c",
    "Test.c",
    "_test.c",
    "_test.zig",
    "test.zig",
    "test.rs",
    "_test.rs",
    "test.py",
    "_test.py",
};

// Zig tests live inline — detect files containing test blocks
const ZIG_TEST_MARKERS = [_][]const u8{
    "test \"",
    "test{",
    "test {",
};

pub fn run(allocator: std.mem.Allocator, cwd: std.fs.Dir) !CheckResult {
    var test_files: std.ArrayList([]const u8) = .empty;
    defer {
        for (test_files.items) |f| allocator.free(f);
        test_files.deinit(allocator);
    }

    try scanDirectory(allocator, cwd, ".", &test_files);

    if (test_files.items.len == 0) {
        const message = try allocator.dupe(u8, "No test files found");
        const rationale = "Automated tests prevent regressions and enable confident refactoring";
        const suggestion = "Add test framework (Catch2, Google Test, Zig test) and write tests for core functionality";

        const references = &[_][]const u8{"rules/testing.md"};

        return CheckResult{
            .tool = "check-tests",
            .status = .fail,
            .message = String.owned(message),
            .rationale = OptionalString.literal(rationale),
            .suggestion = OptionalString.literal(suggestion),
            .references = references,
        };
    }

    const message = try std.fmt.allocPrint(allocator, "Found {d} test files", .{test_files.items.len});

    var details_buf: std.ArrayList(u8) = .empty;
    defer details_buf.deinit(allocator);
    const writer = details_buf.writer(allocator);

    try writer.writeAll("Test files:\n");
    const max_show = @min(test_files.items.len, 10);
    for (test_files.items[0..max_show]) |f| {
        try writer.print("  - {s}\n", .{f});
    }
    if (test_files.items.len > max_show) {
        try writer.print("  ... and {d} more\n", .{test_files.items.len - max_show});
    }

    return CheckResult{
        .tool = "check-tests",
        .status = .pass,
        .message = String.owned(message),
        .details = OptionalString.owned(try details_buf.toOwnedSlice(allocator)),
    };
}

fn scanDirectory(allocator: std.mem.Allocator, base_dir: std.fs.Dir, rel_path: []const u8, test_files: *std.ArrayList([]const u8)) !void {
    var dir = base_dir.openDir(rel_path, .{ .iterate = true }) catch return;
    defer dir.close();

    var iter = dir.iterate();
    while (try iter.next()) |entry| {
        if (entry.name[0] == '.') continue;
        if (std.mem.eql(u8, entry.name, "build")) continue;
        if (std.mem.eql(u8, entry.name, "zig-cache")) continue;
        if (std.mem.eql(u8, entry.name, "zig-out")) continue;
        if (std.mem.eql(u8, entry.name, "node_modules")) continue;
        if (std.mem.eql(u8, entry.name, "target")) continue;

        const full_path = try std.fs.path.join(allocator, &[_][]const u8{ rel_path, entry.name });
        defer allocator.free(full_path);

        if (entry.kind == .directory) {
            try scanDirectory(allocator, base_dir, full_path, test_files);
        } else if (entry.kind == .file) {
            if (isTestFile(entry.name)) {
                const owned_path = try allocator.dupe(u8, full_path);
                try test_files.append(allocator, owned_path);
            } else if (isZigFile(entry.name)) {
                if (try zigFileHasTests(allocator, base_dir, full_path)) {
                    const owned_path = try allocator.dupe(u8, full_path);
                    try test_files.append(allocator, owned_path);
                }
            }
        }
    }
}

fn isTestFile(filename: []const u8) bool {
    for (TEST_PATTERNS) |pattern| {
        if (std.mem.indexOf(u8, filename, pattern)) |_| {
            return true;
        }
    }
    return false;
}

fn isZigFile(filename: []const u8) bool {
    return std.mem.endsWith(u8, filename, ".zig");
}

// Zig puts tests inline — scan for test blocks rather than relying on file naming
fn zigFileHasTests(allocator: std.mem.Allocator, base_dir: std.fs.Dir, path: []const u8) !bool {
    const file = base_dir.openFile(path, .{}) catch return false;
    defer file.close();

    const content = file.readToEndAlloc(allocator, 10 * 1024 * 1024) catch return false;
    defer allocator.free(content);

    var lines = std.mem.splitScalar(u8, content, '\n');
    while (lines.next()) |line| {
        const trimmed = std.mem.trim(u8, line, " \t\r");
        for (ZIG_TEST_MARKERS) |marker| {
            if (std.mem.startsWith(u8, trimmed, marker)) return true;
        }
    }
    return false;
}
