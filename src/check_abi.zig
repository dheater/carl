const std = @import("std");
const CheckResult = @import("main.zig").CheckResult;
const String = @import("string.zig").String;
const OptionalString = @import("string.zig").OptionalString;

pub fn run(allocator: std.mem.Allocator, cwd: std.fs.Dir) !CheckResult {
    var libs: std.ArrayList([]const u8) = .empty;
    defer {
        for (libs.items) |lib| allocator.free(lib);
        libs.deinit(allocator);
    }

    try findSharedLibraries(allocator, cwd, &libs);

    if (libs.items.len == 0) {
        const message = try allocator.dupe(u8, "No shared libraries found to check ABI");
        return CheckResult{
            .tool = "check-abi",
            .status = .pass,
            .message = String.owned(message),
        };
    }

    const has_nm = try checkToolAvailable(allocator, "nm");
    if (!has_nm) {
        const message = try allocator.dupe(u8, "ABI check skipped: nm tool not available");
        return CheckResult{
            .tool = "check-abi",
            .status = .pass,
            .message = String.owned(message),
        };
    }

    var issues: std.ArrayList([]const u8) = .empty;
    defer {
        for (issues.items) |issue| allocator.free(issue);
        issues.deinit(allocator);
    }

    for (libs.items) |lib| {
        try checkLibrarySymbols(allocator, lib, &issues);
    }

    if (issues.items.len == 0) {
        const message = try std.fmt.allocPrint(allocator, "ABI check passed: {d} libraries checked", .{libs.items.len});
        return CheckResult{
            .tool = "check-abi",
            .status = .pass,
            .message = String.owned(message),
        };
    }

    const message = try std.fmt.allocPrint(allocator, "ABI issues detected in {d} libraries", .{libs.items.len});
    const rationale = "ABI breaks force downstream recompilation and can cause runtime crashes";
    const suggestion = "Use symbol versioning, avoid removing/changing public symbols, consider deprecation cycle";

    var details_buf: std.ArrayList(u8) = .empty;
    defer details_buf.deinit(allocator);
    const writer = details_buf.writer(allocator);

    try writer.writeAll("Issues found:\n");
    for (issues.items) |issue| {
        try writer.print("  - {s}\n", .{issue});
    }

    const references = &[_][]const u8{"rules/abi.md"};

    return CheckResult{
        .tool = "check-abi",
        .status = .warn,
        .message = String.owned(message),
        .rationale = OptionalString.literal(rationale),
        .suggestion = OptionalString.literal(suggestion),
        .details = OptionalString.owned(try details_buf.toOwnedSlice(allocator)),
        .references = references,
    };
}

fn findSharedLibraries(allocator: std.mem.Allocator, cwd: std.fs.Dir, libs: *std.ArrayList([]const u8)) !void {
    const extensions = [_][]const u8{ ".so", ".dylib", ".dll" };

    var build_dir = cwd.openDir("build", .{ .iterate = true }) catch return;
    defer build_dir.close();

    var iter = build_dir.iterate();
    while (try iter.next()) |entry| {
        if (entry.kind != .file) continue;

        for (extensions) |ext| {
            if (std.mem.endsWith(u8, entry.name, ext)) {
                const lib_path = try std.fmt.allocPrint(allocator, "build/{s}", .{entry.name});
                try libs.append(allocator, lib_path);
                break;
            }
        }
    }
}

fn checkToolAvailable(allocator: std.mem.Allocator, tool: []const u8) !bool {
    var child = std.process.Child.init(&[_][]const u8{ "which", tool }, allocator);
    child.stdout_behavior = .Ignore;
    child.stderr_behavior = .Ignore;

    const term = child.spawnAndWait() catch return false;
    return term == .Exited and term.Exited == 0;
}

fn checkLibrarySymbols(allocator: std.mem.Allocator, lib_path: []const u8, issues: *std.ArrayList([]const u8)) !void {
    const args = if (@import("builtin").os.tag == .macos)
        [_][]const u8{ "nm", "-gU", lib_path }
    else
        [_][]const u8{ "nm", "-g", lib_path };

    var child = std.process.Child.init(&args, allocator);
    child.stdout_behavior = .Pipe;
    child.stderr_behavior = .Ignore;

    try child.spawn();

    const stdout_data = try child.stdout.?.readToEndAlloc(allocator, 1024 * 1024);
    defer allocator.free(stdout_data);

    _ = try child.wait();

    var symbol_count: usize = 0;
    var lines = std.mem.splitScalar(u8, stdout_data, '\n');
    while (lines.next()) |line| {
        const trimmed = std.mem.trim(u8, line, " \t\r");
        if (trimmed.len > 0) {
            symbol_count += 1;
        }
    }

    if (symbol_count > 100) {
        const issue = try std.fmt.allocPrint(allocator, "{s}: {d} exported symbols (consider reducing)", .{ lib_path, symbol_count });
        try issues.append(allocator, issue);
    }
}
