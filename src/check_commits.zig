const std = @import("std");
const CheckResult = @import("main.zig").CheckResult;
const String = @import("string.zig").String;
const OptionalString = @import("string.zig").OptionalString;

const VALID_TYPES = [_][]const u8{ "feat", "fix", "docs", "style", "refactor", "test", "chore", "perf", "ci", "build", "revert" };

pub fn run(allocator: std.mem.Allocator, cwd: std.fs.Dir) !CheckResult {
    _ = cwd;

    const has_git = try checkToolAvailable(allocator, "git");
    if (!has_git) {
        const message = try allocator.dupe(u8, "Commit check skipped: git not available");
        return CheckResult{
            .tool = "check-commits",
            .status = .pass,
            .message = String.owned(message),
        };
    }

    var commits: std.ArrayList([]const u8) = .empty;
    defer {
        for (commits.items) |commit| allocator.free(commit);
        commits.deinit(allocator);
    }

    try getRecentCommits(allocator, &commits);

    if (commits.items.len == 0) {
        const message = try allocator.dupe(u8, "No commits found to check");
        return CheckResult{
            .tool = "check-commits",
            .status = .pass,
            .message = String.owned(message),
        };
    }

    var non_conventional: std.ArrayList([]const u8) = .empty;
    defer {
        for (non_conventional.items) |msg| allocator.free(msg);
        non_conventional.deinit(allocator);
    }

    for (commits.items) |commit| {
        if (!isConventionalCommit(commit)) {
            const copy = try allocator.dupe(u8, commit);
            try non_conventional.append(allocator, copy);
        }
    }

    if (non_conventional.items.len == 0) {
        const message = try std.fmt.allocPrint(allocator, "All {d} recent commits follow conventional format", .{commits.items.len});
        return CheckResult{
            .tool = "check-commits",
            .status = .pass,
            .message = String.owned(message),
        };
    }

    const message = try std.fmt.allocPrint(allocator, "{d}/{d} commits are non-conventional", .{ non_conventional.items.len, commits.items.len });
    const rationale = "Conventional commits enable automated changelog generation and semantic versioning";
    const suggestion = "Use format: type(scope): message. Valid types: feat, fix, docs, style, refactor, test, chore";

    var details_buf: std.ArrayList(u8) = .empty;
    defer details_buf.deinit(allocator);
    const writer = details_buf.writer(allocator);

    try writer.writeAll("Non-conventional commits:\n");
    for (non_conventional.items) |msg| {
        const truncated = if (msg.len > 60) msg[0..60] else msg;
        try writer.print("  - {s}{s}\n", .{ truncated, if (msg.len > 60) "..." else "" });
    }

    const references = &[_][]const u8{
    "https://www.conventionalcommits.org"};

    return CheckResult{
        .tool = "check-commits",
        .status = .warn,
        .message = String.owned(message),
        .rationale = OptionalString.literal(rationale),
        .suggestion = OptionalString.literal(suggestion),
        .details = OptionalString.owned(try details_buf.toOwnedSlice(allocator)),
        .references = references,
    };
}

fn checkToolAvailable(allocator: std.mem.Allocator, tool: []const u8) !bool {
    var child = std.process.Child.init(&[_][]const u8{ "which", tool }, allocator);
    child.stdout_behavior = .Ignore;
    child.stderr_behavior = .Ignore;
    
    const term = child.spawnAndWait() catch return false;
    return term == .Exited and term.Exited == 0;
}

fn getRecentCommits(allocator: std.mem.Allocator, commits: *std.ArrayList([]const u8)) !void {
    var child = std.process.Child.init(&[_][]const u8{ "git", "log", "--format=%s", "-n", "10" }, allocator);
    child.stdout_behavior = .Pipe;
    child.stderr_behavior = .Ignore;

    try child.spawn();

    const stdout_data = try child.stdout.?.readToEndAlloc(allocator, 1024 * 1024);
    defer allocator.free(stdout_data);

    _ = try child.wait();

    var lines = std.mem.splitScalar(u8, stdout_data, '\n');
    while (lines.next()) |line| {
        const trimmed = std.mem.trim(u8, line, " \t\r");
        if (trimmed.len > 0) {
            const copy = try allocator.dupe(u8, trimmed);
            try commits.append(allocator, copy);
        }
    }
}

fn isConventionalCommit(msg: []const u8) bool {
    const colon_pos = std.mem.indexOfScalar(u8, msg, ':') orelse return false;
    if (colon_pos == 0) return false;

    const prefix = msg[0..colon_pos];

    if (std.mem.indexOfScalar(u8, prefix, '(')) |paren_pos| {
        const type_part = prefix[0..paren_pos];
        return isValidType(type_part);
    }

    return isValidType(prefix);
}

fn isValidType(type_str: []const u8) bool {
    for (VALID_TYPES) |valid_type| {
        if (std.mem.eql(u8, type_str, valid_type)) {
            return true;
        }
    }
    return false;
}

