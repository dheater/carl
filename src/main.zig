const std = @import("std");
const check_deps = @import("check_deps.zig");
const check_abi = @import("check_abi.zig");
const check_commits = @import("check_commits.zig");
const check_exports = @import("check_exports.zig");
const check_comments = @import("check_comments.zig");
const check_docs = @import("check_docs.zig");
const check_logs = @import("check_logs.zig");
const string = @import("string.zig");

pub const CheckResult = struct {
    tool: []const u8,
    status: enum { pass, warn, fail },
    message: string.String,
    rationale: string.OptionalString = string.OptionalString.none(),
    suggestion: string.OptionalString = string.OptionalString.none(),
    details: string.OptionalString = string.OptionalString.none(),
    references: ?[]const []const u8 = null,

    pub fn deinit(self: CheckResult, allocator: std.mem.Allocator) void {
        self.message.deinit(allocator);
        self.rationale.deinit(allocator);
        self.suggestion.deinit(allocator);
        self.details.deinit(allocator);
    }

    pub fn jsonStringify(self: CheckResult, jws: anytype) !void {
        try jws.beginObject();
        try jws.objectField("tool");
        try jws.write(self.tool);
        try jws.objectField("status");
        try jws.write(@tagName(self.status));
        try jws.objectField("message");
        try jws.write(self.message.slice());
        try jws.objectField("rationale");
        try jws.write(self.rationale.slice());
        try jws.objectField("suggestion");
        try jws.write(self.suggestion.slice());
        try jws.objectField("details");
        try jws.write(self.details.slice());
        try jws.objectField("references");
        try jws.write(self.references);
        try jws.endObject();
    }
};

const Command = enum {
    check_deps,
    check_abi,
    check_commits,
    check_exports,
    check_comments,
    check_docs,
    check_logs,
    check_all,
};

pub fn main() !void {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();

    const args = try std.process.argsAlloc(allocator);
    defer std.process.argsFree(allocator, args);

    if (args.len < 2) {
        try printUsage();
        return;
    }

    const cwd = std.fs.cwd();
    const cmd = std.meta.stringToEnum(Command, args[1]) orelse {
        try printUsage();
        return;
    };

    const result = switch (cmd) {
        .check_deps => try check_deps.run(allocator, cwd),
        .check_abi => try check_abi.run(allocator, cwd),
        .check_commits => try check_commits.run(allocator, cwd),
        .check_exports => try check_exports.run(allocator, cwd),
        .check_comments => try check_comments.run(allocator, cwd),
        .check_docs => try check_docs.run(allocator, cwd),
        .check_logs => try check_logs.run(allocator, cwd),
        .check_all => try checkAll(allocator, cwd),
    };
    defer result.deinit(allocator);

    try outputJson(allocator, result);
}

fn checkAll(allocator: std.mem.Allocator, cwd: std.fs.Dir) !CheckResult {
    var results: std.ArrayList(CheckResult) = .empty;
    defer {
        for (results.items) |r| r.deinit(allocator);
        results.deinit(allocator);
    }

    try results.append(allocator, try check_deps.run(allocator, cwd));
    try results.append(allocator, try check_abi.run(allocator, cwd));
    try results.append(allocator, try check_commits.run(allocator, cwd));
    try results.append(allocator, try check_exports.run(allocator, cwd));
    try results.append(allocator, try check_comments.run(allocator, cwd));
    try results.append(allocator, try check_docs.run(allocator, cwd));
    try results.append(allocator, try check_logs.run(allocator, cwd));

    var fail_count: usize = 0;
    var warn_count: usize = 0;
    for (results.items) |r| {
        if (r.status == .fail) fail_count += 1;
        if (r.status == .warn) warn_count += 1;
    }

    const Status = @TypeOf(@as(CheckResult, undefined).status);
    const status: Status = if (fail_count > 0) .fail else if (warn_count > 0) .warn else .pass;
    const message = try std.fmt.allocPrint(allocator, "Ran {d} checks: {d} passed, {d} warnings, {d} failures", .{
        results.items.len,
        results.items.len - warn_count - fail_count,
        warn_count,
        fail_count,
    });

    return CheckResult{
        .tool = "check-all",
        .status = status,
        .message = string.String.owned(message),
    };
}

fn outputJson(allocator: std.mem.Allocator, result: CheckResult) !void {
    var json_string: std.io.Writer.Allocating = .init(allocator);
    defer json_string.deinit();

    try json_string.writer.print("{f}", .{std.json.fmt(result, .{ .whitespace = .indent_2 })});

    const stdout_file = std.fs.File.stdout();
    try stdout_file.writeAll(json_string.written());
    try stdout_file.writeAll("\n");
}

fn printUsage() !void {
    std.debug.print(
        \\Carl - Development principles enforcement
        \\
        \\Usage: carl <command>
        \\
        \\Commands:
        \\  check_deps      Check dependency budget (≤5 runtime deps)
        \\  check_abi       Check ABI stability (no breaking changes)
        \\  check_commits   Check conventional commits format
        \\  check_exports   Check symbol visibility
        \\  check_comments  Check for narration comments
        \\  check_docs      Check for unsolicited .md files
        \\  check_logs      Check structured logging format
        \\  check_all       Run all checks
        \\
        \\Output: JSON (parseable by AI/CI)
        \\Exit code: 0 (advisory, not blocking)
        \\
        \\See: https://github.com/carl-lang/carl
        \\
    , .{});
}

test {
    _ = @import("check_deps.zig");
    _ = @import("check_abi.zig");
    _ = @import("check_commits.zig");
    _ = @import("check_exports.zig");
    _ = @import("check_comments.zig");
    _ = @import("check_docs.zig");
    _ = @import("check_logs.zig");
}

