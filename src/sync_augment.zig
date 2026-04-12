const std = @import("std");
const string = @import("string.zig");
const CheckResult = @import("main.zig").CheckResult;

pub fn run(allocator: std.mem.Allocator, cwd: std.fs.Dir) !CheckResult {
    const home = try getHomeDir(allocator);
    defer allocator.free(home);

    const augment_rules = try std.fs.path.join(allocator, &.{ home, ".augment", "rules" });
    defer allocator.free(augment_rules);

    const augment_skills = try std.fs.path.join(allocator, &.{ home, ".augment", "skills" });
    defer allocator.free(augment_skills);

    // Clean destinations before copying so deleted source files don't persist
    std.fs.deleteTreeAbsolute(augment_rules) catch |err| switch (err) {
        error.FileNotFound => {},
        else => return err,
    };
    std.fs.deleteTreeAbsolute(augment_skills) catch |err| switch (err) {
        error.FileNotFound => {},
        else => return err,
    };

    try std.fs.cwd().makePath(augment_rules);
    try std.fs.cwd().makePath(augment_skills);

    const rule_count = try copyMarkdownFiles(allocator, cwd, "rules", augment_rules);
    const skill_count = try copyMarkdownFiles(allocator, cwd, "skills", augment_skills);

    const message = try std.fmt.allocPrint(
        allocator,
        "Synced {d} rules to {s}, {d} skills to {s}",
        .{ rule_count, augment_rules, skill_count, augment_skills },
    );

    return CheckResult{
        .tool = "sync-augment",
        .status = .pass,
        .message = string.String.owned(message),
    };
}

fn copyMarkdownFiles(
    allocator: std.mem.Allocator,
    cwd: std.fs.Dir,
    source_dir_path: []const u8,
    dest_dir_path: []const u8,
) !usize {
    var source_dir = try cwd.openDir(source_dir_path, .{ .iterate = true });
    defer source_dir.close();

    var it = source_dir.iterate();
    var count: usize = 0;

    while (try it.next()) |entry| {
        if (entry.kind != .file) continue;
        if (!std.mem.endsWith(u8, entry.name, ".md")) continue;

        const contents = try source_dir.readFileAlloc(allocator, entry.name, 1 << 20);
        defer allocator.free(contents);

        const dest_path = try std.fs.path.join(allocator, &.{ dest_dir_path, entry.name });
        defer allocator.free(dest_path);

        var dest_file = try std.fs.cwd().createFile(dest_path, .{ .truncate = true });
        defer dest_file.close();
        try dest_file.writeAll(contents);
        count += 1;
    }

    return count;
}

fn getHomeDir(allocator: std.mem.Allocator) ![]u8 {
    return std.process.getEnvVarOwned(allocator, "HOME") catch
        std.process.getEnvVarOwned(allocator, "USERPROFILE");
}
