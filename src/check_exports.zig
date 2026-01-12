const std = @import("std");
const CheckResult = @import("main.zig").CheckResult;
const String = @import("string.zig").String;
const OptionalString = @import("string.zig").OptionalString;

const EXPECTED_PREFIXES = [_][]const u8{ "carl_", "lib_", "app_", "_" };

pub fn run(allocator: std.mem.Allocator, cwd: std.fs.Dir) !CheckResult {
    var libs: std.ArrayList([]const u8) = .empty;
    defer {
        for (libs.items) |lib| allocator.free(lib);
        libs.deinit(allocator);
    }

    try findSharedLibraries(allocator, cwd, &libs);

    if (libs.items.len == 0) {
        const message = try allocator.dupe(u8, "No shared libraries found to check exports");
        return CheckResult{
            .tool = "check-exports",
            .status = .pass,
            .message = String.owned(message),
        };
    }

    const has_nm = try checkToolAvailable(allocator, "nm");
    if (!has_nm) {
        const message = try allocator.dupe(u8, "Export check skipped: nm tool not available");
        return CheckResult{
            .tool = "check-exports",
            .status = .pass,
            .message = String.owned(message),
        };
    }

    var unexpected_symbols: std.ArrayList([]const u8) = .empty;
    defer {
        for (unexpected_symbols.items) |sym| allocator.free(sym);
        unexpected_symbols.deinit(allocator);
    }

    for (libs.items) |lib| {
        try checkLibraryExports(allocator, lib, &unexpected_symbols);
    }

    if (unexpected_symbols.items.len == 0) {
        const message = try std.fmt.allocPrint(allocator, "All exports properly prefixed in {d} libraries", .{libs.items.len});
        return CheckResult{
            .tool = "check-exports",
            .status = .pass,
            .message = String.owned(message),
        };
    }

    const message = try std.fmt.allocPrint(allocator, "Found {d} unexpected exported symbols", .{unexpected_symbols.items.len});
    const rationale = "Unprefixed symbols pollute global namespace and can cause conflicts with other libraries";
    const suggestion = "Prefix all public symbols with project namespace (lib_, app_, etc.) or mark as static/hidden";

    var details_buf: std.ArrayList(u8) = .empty;
    defer details_buf.deinit(allocator);
    const writer = details_buf.writer(allocator);

    try writer.writeAll("Unexpected exports:\n");
    const max_show = @min(unexpected_symbols.items.len, 20);
    for (unexpected_symbols.items[0..max_show]) |sym| {
        try writer.print("  - {s}\n", .{sym});
    }
    if (unexpected_symbols.items.len > max_show) {
        try writer.print("  ... and {d} more\n", .{unexpected_symbols.items.len - max_show});
    }

    const references = &[_][]const u8{
    "rules/exports.md"};

    return CheckResult{
        .tool = "check-exports",
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

fn checkLibraryExports(allocator: std.mem.Allocator, lib_path: []const u8, unexpected: *std.ArrayList([]const u8)) !void {
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

    var lines = std.mem.splitScalar(u8, stdout_data, '\n');
    while (lines.next()) |line| {
        const trimmed = std.mem.trim(u8, line, " \t\r");
        if (trimmed.len == 0) continue;

        var parts = std.mem.splitScalar(u8, trimmed, ' ');
        _ = parts.next();
        const sym_type = parts.next() orelse continue;
        const symbol = parts.next() orelse continue;

        if (!std.mem.eql(u8, sym_type, "T")) continue;

        if (!hasExpectedPrefix(symbol)) {
            const copy = try allocator.dupe(u8, symbol);
            try unexpected.append(allocator, copy);
        }
    }
}

fn hasExpectedPrefix(symbol: []const u8) bool {
    for (EXPECTED_PREFIXES) |prefix| {
        if (std.mem.startsWith(u8, symbol, prefix)) {
            return true;
        }
    }
    return false;
}

