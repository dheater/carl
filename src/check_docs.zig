const std = @import("std");
const CheckResult = @import("main.zig").CheckResult;
const String = @import("string.zig").String;
const OptionalString = @import("string.zig").OptionalString;

pub fn run(allocator: std.mem.Allocator, cwd: std.fs.Dir) !CheckResult {
    _ = cwd;

    const has_git = try checkToolAvailable(allocator, "git");
    if (!has_git) {
        const message = try allocator.dupe(u8, "Docs check skipped: git not available");
        return CheckResult{
            .tool = "check-docs",
            .status = .pass,
            .message = String.owned(message),
        };
    }

    var new_md_files: std.ArrayList([]const u8) = .empty;
    defer {
        for (new_md_files.items) |f| allocator.free(f);
        new_md_files.deinit(allocator);
    }

    try getNewMarkdownFiles(allocator, &new_md_files);

    if (new_md_files.items.len == 0) {
        const message = try allocator.dupe(u8, "No new .md files added");
        return CheckResult{
            .tool = "check-docs",
            .status = .pass,
            .message = String.owned(message),
        };
    }

    const commit_msg = try getLastCommitMessage(allocator);
    defer allocator.free(commit_msg);

    const mentions_docs = std.mem.indexOf(u8, commit_msg, "doc") != null or
        std.mem.indexOf(u8, commit_msg, "readme") != null or
        std.mem.indexOf(u8, commit_msg, "README") != null;

    if (mentions_docs) {
        const message = try std.fmt.allocPrint(allocator, "{d} new .md files added (explicitly documented)", .{new_md_files.items.len});
        return CheckResult{
            .tool = "check-docs",
            .status = .pass,
            .message = String.owned(message),
        };
    }

    const message = try std.fmt.allocPrint(allocator, "Found {d} unsolicited .md files", .{new_md_files.items.len});
    const rationale = "Unsolicited documentation files add maintenance burden and often become stale";
    const suggestion = "Only create .md files when explicitly requested. Prefer self-documenting code and inline comments";

    var details_buf: std.ArrayList(u8) = .empty;
    defer details_buf.deinit(allocator);
    const writer = details_buf.writer(allocator);

    try writer.writeAll("New .md files:\n");
    for (new_md_files.items) |f| {
        try writer.print("  - {s}\n", .{f});
    }

    const references = &[_][]const u8{
    "rules/documentation.md"};

    return CheckResult{
        .tool = "check-docs",
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

fn getNewMarkdownFiles(allocator: std.mem.Allocator, files: *std.ArrayList([]const u8)) !void {
    var child = std.process.Child.init(&[_][]const u8{ "git", "diff", "--name-only", "--diff-filter=A", "HEAD" }, allocator);
    child.stdout_behavior = .Pipe;
    child.stderr_behavior = .Ignore;

    try child.spawn();

    const stdout_data = try child.stdout.?.readToEndAlloc(allocator, 1024 * 1024);
    defer allocator.free(stdout_data);

    _ = try child.wait();

    var lines = std.mem.splitScalar(u8, stdout_data, '\n');
    while (lines.next()) |line| {
        const trimmed = std.mem.trim(u8, line, " \t\r");
        if (trimmed.len > 0 and std.mem.endsWith(u8, trimmed, ".md")) {
            const copy = try allocator.dupe(u8, trimmed);
            try files.append(allocator, copy);
        }
    }
}

fn getLastCommitMessage(allocator: std.mem.Allocator) ![]const u8 {
    var child = std.process.Child.init(&[_][]const u8{ "git", "log", "-1", "--format=%B" }, allocator);
    child.stdout_behavior = .Pipe;
    child.stderr_behavior = .Ignore;

    try child.spawn();

    const stdout_data = try child.stdout.?.readToEndAlloc(allocator, 1024 * 1024);
    errdefer allocator.free(stdout_data);

    _ = try child.wait();

    return stdout_data;
}

