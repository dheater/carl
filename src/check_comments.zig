const std = @import("std");
const CheckResult = @import("main.zig").CheckResult;
const String = @import("string.zig").String;
const OptionalString = @import("string.zig").OptionalString;

const NARRATION_PATTERNS = [_][]const u8{
    "// Loop through",
    "// Check if",
    "// Increment",
    "// Set ",
    "// Get ",
    "// Initialize",
    "// Create ",
    "// Return",
    "// Call ",
    "// Add ",
    "// Remove ",
    "// Update ",
};

const SOURCE_EXTENSIONS = [_][]const u8{ ".c", ".cpp", ".h", ".hpp", ".zig", ".cc", ".cxx" };
const MAX_DETAILS_SHOW = 15;

pub fn run(allocator: std.mem.Allocator, cwd: std.fs.Dir) !CheckResult {
    var narrations: std.ArrayList([]const u8) = .empty;
    defer {
        for (narrations.items) |n| allocator.free(n);
        narrations.deinit(allocator);
    }

    try scanDirectory(allocator, cwd, ".", &narrations);

    if (narrations.items.len == 0) {
        const message = try allocator.dupe(u8, "No narration comments found");
        return CheckResult{
            .tool = "check-comments",
            .status = .pass,
            .message = String.owned(message),
        };
    }

    const message = try std.fmt.allocPrint(allocator, "Found {d} narration comments", .{narrations.items.len});
    const rationale = "Narration comments describe WHAT the code does (already visible). Good comments explain WHY";
    const suggestion = "Replace narration with intent: explain business logic, edge cases, or non-obvious decisions";

    var details_buf: std.ArrayList(u8) = .empty;
    defer details_buf.deinit(allocator);
    const writer = details_buf.writer(allocator);

    try writer.writeAll("Narration comments found:\n");
    const max_show = @min(narrations.items.len, MAX_DETAILS_SHOW);
    for (narrations.items[0..max_show]) |n| {
        try writer.print("  - {s}\n", .{n});
    }
    if (narrations.items.len > max_show) {
        try writer.print("  ... and {d} more\n", .{narrations.items.len - max_show});
    }

    const references = &[_][]const u8{"rules/comments.md"};

    return CheckResult{
        .tool = "check-comments",
        .status = .warn,
        .message = String.owned(message),
        .rationale = OptionalString.literal(rationale),
        .suggestion = OptionalString.literal(suggestion),
        .details = OptionalString.owned(try details_buf.toOwnedSlice(allocator)),
        .references = references,
    };
}

fn scanDirectory(allocator: std.mem.Allocator, base_dir: std.fs.Dir, rel_path: []const u8, narrations: *std.ArrayList([]const u8)) !void {
    var dir = base_dir.openDir(rel_path, .{ .iterate = true }) catch return;
    defer dir.close();

    var iter = dir.iterate();
    while (try iter.next()) |entry| {
        if (entry.name[0] == '.') continue;
        if (std.mem.eql(u8, entry.name, "build")) continue;
        if (std.mem.eql(u8, entry.name, "zig-cache")) continue;
        if (std.mem.eql(u8, entry.name, "zig-out")) continue;

        const full_path = try std.fs.path.join(allocator, &[_][]const u8{ rel_path, entry.name });
        defer allocator.free(full_path);

        if (entry.kind == .directory) {
            try scanDirectory(allocator, base_dir, full_path, narrations);
        } else if (entry.kind == .file) {
            if (isSourceFile(entry.name)) {
                try scanFile(allocator, base_dir, full_path, narrations);
            }
        }
    }
}

fn isSourceFile(filename: []const u8) bool {
    for (SOURCE_EXTENSIONS) |ext| {
        if (std.mem.endsWith(u8, filename, ext)) {
            return true;
        }
    }
    return false;
}

fn scanFile(allocator: std.mem.Allocator, base_dir: std.fs.Dir, path: []const u8, narrations: *std.ArrayList([]const u8)) !void {
    const file = base_dir.openFile(path, .{}) catch return;
    defer file.close();

    const content = file.readToEndAlloc(allocator, 10 * 1024 * 1024) catch return;
    defer allocator.free(content);

    var line_num: usize = 1;
    var lines = std.mem.splitScalar(u8, content, '\n');

    while (lines.next()) |line| : (line_num += 1) {
        const trimmed = std.mem.trim(u8, line, " \t\r");

        if (!std.mem.startsWith(u8, trimmed, "//")) continue;

        for (NARRATION_PATTERNS) |pattern| {
            if (std.mem.indexOf(u8, trimmed, pattern)) |_| {
                const location = try std.fmt.allocPrint(allocator, "{s}:{d}: {s}", .{ path, line_num, trimmed });
                try narrations.append(allocator, location);
                break;
            }
        }
    }
}
