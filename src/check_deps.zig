const std = @import("std");
const CheckResult = @import("main.zig").CheckResult;
const String = @import("string.zig").String;
const OptionalString = @import("string.zig").OptionalString;

pub fn run(allocator: std.mem.Allocator, cwd: std.fs.Dir) !CheckResult {
    var deps: std.ArrayList([]const u8) = .empty;
    defer {
        for (deps.items) |dep| allocator.free(dep);
        deps.deinit(allocator);
    }

    try findCMakeDeps(allocator, cwd, &deps);
    try findZigDeps(allocator, cwd, &deps);
    try findConanDeps(allocator, cwd, &deps);
    try findCargoDeps(allocator, cwd, &deps);

    const count = deps.items.len;

    const msg = try std.fmt.allocPrint(allocator, "Found {d} runtime dependencies (guideline: ≤5)", .{count});
    const note = "Dependency budget is a guideline, not enforced. See rules/dependencies.md";

    var details_buf: std.ArrayList(u8) = .empty;
    defer details_buf.deinit(allocator);
    const writer = details_buf.writer(allocator);

    if (count > 0) {
        try writer.writeAll("Dependencies found:\n");
        for (deps.items) |dep| {
            try writer.print("  - {s}\n", .{dep});
        }
    }

    const details = if (count > 0)
        OptionalString.owned(try details_buf.toOwnedSlice(allocator))
    else
        OptionalString.none();

    return CheckResult{
        .tool = "check-deps",
        .status = .pass,
        .message = String.owned(msg),
        .rationale = OptionalString.literal(note),
        .details = details,
    };
}

fn findCMakeDeps(allocator: std.mem.Allocator, cwd: std.fs.Dir, deps: *std.ArrayList([]const u8)) !void {
    const file = cwd.openFile("CMakeLists.txt", .{}) catch return;
    defer file.close();

    const content = try file.readToEndAlloc(allocator, 1024 * 1024);
    defer allocator.free(content);

    var idx: usize = 0;
    while (std.mem.indexOfPos(u8, content, idx, "find_package(")) |start| {
        const after_prefix = content[start + "find_package(".len ..];

        const close_paren = std.mem.indexOfScalar(u8, after_prefix, ')') orelse {
            idx = start + 1;
            continue;
        };

        const package_section = std.mem.trim(u8, after_prefix[0..close_paren], " \t\r\n");

        var words = std.mem.tokenizeAny(u8, package_section, " \t\r\n");
        if (words.next()) |first_word| {
            const name = try allocator.dupe(u8, first_word);
            errdefer allocator.free(name);
            try deps.append(allocator, name);
        }

        idx = start + "find_package(".len + close_paren;
    }
}

fn findZigDeps(allocator: std.mem.Allocator, cwd: std.fs.Dir, deps: *std.ArrayList([]const u8)) !void {
    try findZigZonDeps(allocator, cwd, deps);
    try findZigBuildDeps(allocator, cwd, deps);
}

fn findZigZonDeps(allocator: std.mem.Allocator, cwd: std.fs.Dir, deps: *std.ArrayList([]const u8)) !void {
    const file = cwd.openFile("build.zig.zon", .{}) catch return;
    defer file.close();

    const content = try file.readToEndAlloc(allocator, 1024 * 1024);
    defer allocator.free(content);

    var lines = std.mem.splitScalar(u8, content, '\n');
    var in_dependencies = false;

    while (lines.next()) |line| {
        const trimmed = std.mem.trim(u8, line, " \t\r");

        if (std.mem.indexOf(u8, trimmed, ".dependencies") != null) {
            in_dependencies = true;
            continue;
        }

        if (in_dependencies) {
            if (std.mem.indexOf(u8, trimmed, "}") != null) {
                in_dependencies = false;
                continue;
            }

            if (std.mem.indexOf(u8, trimmed, ".") == 0) {
                if (extractZigDepName(allocator, trimmed)) |name| {
                    errdefer allocator.free(name);
                    try deps.append(allocator, name);
                }
            }
        }
    }
}

fn findZigBuildDeps(allocator: std.mem.Allocator, cwd: std.fs.Dir, deps: *std.ArrayList([]const u8)) !void {
    const file = cwd.openFile("build.zig", .{}) catch return;
    defer file.close();

    const content = try file.readToEndAlloc(allocator, 1024 * 1024);
    defer allocator.free(content);

    try extractFromStringPattern(allocator, content, "linkSystemLibrary", deps);
}

fn extractFromStringPattern(allocator: std.mem.Allocator, content: []const u8, pattern: []const u8, deps: *std.ArrayList([]const u8)) !void {
    var idx: usize = 0;
    while (std.mem.indexOfPos(u8, content, idx, pattern)) |start| {
        const after_pattern = content[start + pattern.len ..];

        const trimmed = std.mem.trimLeft(u8, after_pattern, " \t");
        if (trimmed.len == 0 or trimmed[0] != '(') {
            idx = start + 1;
            continue;
        }

        const open_paren = after_pattern.len - trimmed.len;
        const after_paren = after_pattern[open_paren + 1 ..];

        const trimmed_after_paren = std.mem.trimLeft(u8, after_paren, " \t\r\n");

        const open_quote = std.mem.indexOfScalar(u8, trimmed_after_paren, '"') orelse {
            idx = start + 1;
            continue;
        };

        if (open_quote > 10) {
            idx = start + 1;
            continue;
        }

        const after_quote = trimmed_after_paren[open_quote + 1 ..];
        const close_quote = std.mem.indexOfScalar(u8, after_quote, '"') orelse {
            idx = start + 1;
            continue;
        };

        const lib_name = after_quote[0..close_quote];
        const name = try allocator.dupe(u8, lib_name);
        errdefer allocator.free(name);
        try deps.append(allocator, name);

        idx = start + pattern.len + open_paren + open_quote + close_quote;
    }
}

fn findConanDeps(allocator: std.mem.Allocator, cwd: std.fs.Dir, deps: *std.ArrayList([]const u8)) !void {
    const file = cwd.openFile("conanfile.txt", .{}) catch {
        const py_file = cwd.openFile("conanfile.py", .{}) catch return;
        defer py_file.close();
        return;
    };
    defer file.close();

    const content = try file.readToEndAlloc(allocator, 1024 * 1024);
    defer allocator.free(content);

    var lines = std.mem.splitScalar(u8, content, '\n');
    var in_requires = false;

    while (lines.next()) |line| {
        const trimmed = std.mem.trim(u8, line, " \t\r");

        if (std.mem.eql(u8, trimmed, "[requires]")) {
            in_requires = true;
            continue;
        }

        if (in_requires) {
            if (trimmed.len > 0 and trimmed[0] == '[') {
                in_requires = false;
                continue;
            }

            if (trimmed.len > 0) {
                const name = try allocator.dupe(u8, trimmed);
                errdefer allocator.free(name);
                try deps.append(allocator, name);
            }
        }
    }
}

fn extractPackageName(allocator: std.mem.Allocator, line: []const u8, prefix: []const u8) ?[]const u8 {
    const start = std.mem.indexOf(u8, line, prefix) orelse return null;
    const after_prefix = line[start + prefix.len ..];
    const end = std.mem.indexOfScalar(u8, after_prefix, ' ') orelse std.mem.indexOfScalar(u8, after_prefix, ')') orelse return null;
    return allocator.dupe(u8, after_prefix[0..end]) catch null;
}

fn extractZigDepName(allocator: std.mem.Allocator, line: []const u8) ?[]const u8 {
    const start = std.mem.indexOfScalar(u8, line, '.') orelse return null;
    const name_start = start + 1;
    const end = std.mem.indexOfScalar(u8, line[name_start..], ' ') orelse std.mem.indexOfScalar(u8, line[name_start..], '=') orelse return null;
    return allocator.dupe(u8, line[name_start .. name_start + end]) catch null;
}

fn findCargoDeps(allocator: std.mem.Allocator, cwd: std.fs.Dir, deps: *std.ArrayList([]const u8)) !void {
    const file = cwd.openFile("Cargo.toml", .{}) catch return;
    defer file.close();

    const content = try file.readToEndAlloc(allocator, 1024 * 1024);
    defer allocator.free(content);

    var lines = std.mem.splitScalar(u8, content, '\n');
    var in_dependencies = false;

    while (lines.next()) |line| {
        const trimmed = std.mem.trim(u8, line, " \t\r");

        if (std.mem.eql(u8, trimmed, "[dependencies]") or
            std.mem.eql(u8, trimmed, "[build-dependencies]")) {
            in_dependencies = true;
            continue;
        }

        if (in_dependencies) {
            if (trimmed.len > 0 and trimmed[0] == '[') {
                in_dependencies = false;
                continue;
            }

            if (std.mem.indexOfScalar(u8, trimmed, '=')) |eq_pos| {
                const name = std.mem.trim(u8, trimmed[0..eq_pos], " \t");
                if (name.len > 0) {
                    const dep_name = try allocator.dupe(u8, name);
                    errdefer allocator.free(dep_name);
                    try deps.append(allocator, dep_name);
                }
            }
        }
    }
}

