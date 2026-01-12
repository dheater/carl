const std = @import("std");
const CheckResult = @import("main.zig").CheckResult;
const String = @import("string.zig").String;
const OptionalString = @import("string.zig").OptionalString;

const SOURCE_EXTENSIONS = [_][]const u8{ ".zig", ".py", ".rs", ".go" };

const LogPattern = struct {
    pattern: []const u8,
    language: []const u8,
};

const LOG_PATTERNS = [_]LogPattern{
    .{ .pattern = "std.log.debug(", .language = ".zig" },
    .{ .pattern = "std.log.info(", .language = ".zig" },
    .{ .pattern = "std.log.warn(", .language = ".zig" },
    .{ .pattern = "std.log.err(", .language = ".zig" },
    .{ .pattern = "logging.debug(", .language = ".py" },
    .{ .pattern = "logging.info(", .language = ".py" },
    .{ .pattern = "logging.warning(", .language = ".py" },
    .{ .pattern = "logging.error(", .language = ".py" },
    .{ .pattern = "log::debug!(", .language = ".rs" },
    .{ .pattern = "log::info!(", .language = ".rs" },
    .{ .pattern = "log::warn!(", .language = ".rs" },
    .{ .pattern = "log::error!(", .language = ".rs" },
    .{ .pattern = "log.Debug(", .language = ".go" },
    .{ .pattern = "log.Info(", .language = ".go" },
    .{ .pattern = "log.Warn(", .language = ".go" },
    .{ .pattern = "log.Error(", .language = ".go" },
};

pub fn run(allocator: std.mem.Allocator, cwd: std.fs.Dir) !CheckResult {
    var unstructured_logs: std.ArrayList([]const u8) = .empty;
    defer {
        for (unstructured_logs.items) |log| allocator.free(log);
        unstructured_logs.deinit(allocator);
    }

    try scanDirectory(allocator, cwd, ".", &unstructured_logs);

    if (unstructured_logs.items.len == 0) {
        const message = try allocator.dupe(u8, "All logs appear to be structured");
        return CheckResult{
            .tool = "check-logs",
            .status = .pass,
            .message = String.owned(message),
        };
    }

    const message = try std.fmt.allocPrint(allocator, "Found {d} unstructured log statements", .{unstructured_logs.items.len});
    const rationale = "Unstructured logs are hard to parse, search, and analyze. Structured logs enable better observability";
    const suggestion = "Use key=value format: std.log.info(\"event=user_login user_id={d} ip={s}\", .{id, addr})";

    var details_buf: std.ArrayList(u8) = .empty;
    defer details_buf.deinit(allocator);
    const writer = details_buf.writer(allocator);

    try writer.writeAll("Unstructured logs:\n");
    const max_show = @min(unstructured_logs.items.len, 15);
    for (unstructured_logs.items[0..max_show]) |log| {
        try writer.print("  - {s}\n", .{log});
    }
    if (unstructured_logs.items.len > max_show) {
        try writer.print("  ... and {d} more\n", .{unstructured_logs.items.len - max_show});
    }

    const references = &[_][]const u8{
    "rules/logging.md"};

    return CheckResult{
        .tool = "check-logs",
        .status = .warn,
        .message = String.owned(message),
        .rationale = OptionalString.literal(rationale),
        .suggestion = OptionalString.literal(suggestion),
        .details = OptionalString.owned(try details_buf.toOwnedSlice(allocator)),
        .references = references,
    };
}

fn scanDirectory(allocator: std.mem.Allocator, base_dir: std.fs.Dir, rel_path: []const u8, logs: *std.ArrayList([]const u8)) !void {
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
            try scanDirectory(allocator, base_dir, full_path, logs);
        } else if (entry.kind == .file) {
            if (isSourceFile(entry.name)) {
                try scanFile(allocator, base_dir, full_path, logs);
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

fn scanFile(allocator: std.mem.Allocator, base_dir: std.fs.Dir, path: []const u8, logs: *std.ArrayList([]const u8)) !void {
    const file = base_dir.openFile(path, .{}) catch return;
    defer file.close();

    const content = file.readToEndAlloc(allocator, 10 * 1024 * 1024) catch return;
    defer allocator.free(content);

    var line_num: usize = 1;
    var lines = std.mem.splitScalar(u8, content, '\n');

    while (lines.next()) |line| : (line_num += 1) {
        const trimmed = std.mem.trim(u8, line, " \t\r");

        if (isStringLiteral(trimmed)) continue;

        for (LOG_PATTERNS) |log_pattern| {
            if (!std.mem.endsWith(u8, path, log_pattern.language)) continue;

            if (std.mem.indexOf(u8, trimmed, log_pattern.pattern)) |_| {
                if (!hasKeyValuePattern(trimmed)) {
                    const location = try std.fmt.allocPrint(allocator, "{s}:{d}: {s}", .{ path, line_num, trimmed });
                    try logs.append(allocator, location);
                    break;
                }
            }
        }
    }
}

fn isStringLiteral(line: []const u8) bool {
    const trimmed = std.mem.trim(u8, line, " \t\r");
    if (trimmed.len < 2) return false;

    if (std.mem.indexOf(u8, trimmed, ".pattern = ") != null) return true;
    if (std.mem.indexOf(u8, trimmed, ".language = ") != null) return true;

    return (std.mem.startsWith(u8, trimmed, "\"") and std.mem.endsWith(u8, trimmed, "\",")) or
           (std.mem.startsWith(u8, trimmed, "\"") and std.mem.endsWith(u8, trimmed, "\""));
}

fn hasKeyValuePattern(line: []const u8) bool {
    var i: usize = 0;
    while (i < line.len) : (i += 1) {
        if (line[i] == '=') {
            if (i > 0) {
                var j = i - 1;
                while (j > 0 and (std.ascii.isAlphanumeric(line[j]) or line[j] == '_')) {
                    j -= 1;
                }
                if (i - j > 1) return true;
            }
        }
    }
    return false;
}

