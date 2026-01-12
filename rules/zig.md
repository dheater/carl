# Zig Guidelines

**Enforcement:** Language-specific guidelines (not automated, use zig fmt + manual review)

## Principle

Use `errdefer` for cleanup, allocators explicit, ArrayList is unmanaged (`.empty` + pass allocator). Match allocation strategy to lifetime. Make invalid states unrepresentable.

---

## Why

- **errdefer prevents leaks** - Automatic cleanup on error, compiler-verified
- **Explicit allocators** - No hidden allocations, clear ownership
- **Type system prevents bugs** - Optional types, sentinel pointers, error unions
- **Simplicity over cleverness** - Explicit over implicit (Zig philosophy)

---

## Memory Management

### ArrayList (Zig 0.15)

**Unmanaged by default. Use `.empty` + pass allocator.**

```zig
// ✅ DO
pub const Engine = struct {
    items: std.ArrayList(Item),
    pub fn init(allocator: std.mem.Allocator) Engine {
        return .{ .allocator = allocator, .items = .empty };
    }
    pub fn deinit(self: *Engine) void {
        self.items.deinit(self.allocator);
    }
};

// ❌ DON'T - Old syntax
var list = std.ArrayList(u32).init(allocator);  // Deprecated!
```

### Allocation Strategy

```
Multiple temporary allocations with same lifetime?
  YES → Arena Allocator
  NO  → Single temporary?
    YES → Simple + defer
    NO  → Long-lived struct?
      YES → Simple + deinit
      NO  → Performance-critical?
        YES → Optimize
        NO  → Keep simple
```

**Patterns:**

| Pattern | When | Example |
|---------|------|---------|
| Arena | Multiple temp allocations | HTTP request with temp strings |
| Pre-allocate | Size known | `initCapacity(allocator, n)` |
| Reuse capacity | Refresh data | `clearRetainingCapacity()` |

---

## Error Handling

### errdefer for Cleanup

**Use in init functions. Automatic cleanup on error.**

```zig
// ✅ DO
pub fn init(allocator: std.mem.Allocator) !AppContext {
    try sdl.init(sdl.SDL_INIT_VIDEO);
    errdefer sdl.quit();

    const window = try sdl.createWindow("App", 1200, 800, 0);
    errdefer sdl.destroyWindow(window);

    const renderer = try sdl.createRenderer(window, null);
    errdefer sdl.destroyRenderer(renderer);

    return AppContext{ .window = window, .renderer = renderer };
}

// ❌ DON'T - Manual cleanup on every error path
pub fn init(allocator: std.mem.Allocator) !AppContext {
    try sdl.init(sdl.SDL_INIT_VIDEO);
    const window = sdl.createWindow("App", 1200, 800, 0) catch |err| {
        sdl.quit();
        return err;
    };
    // Fragile: Every new resource requires updating all error paths
}
```

**When to use:** Init functions with multiple resources, cleanup order matters, multiple error paths

**When NOT to use:** Single allocation (use `defer`), no errors (use `defer`)

### Error Unions

```zig
// ✅ DO - Specific error types
pub const ClientError = error{ InitFailed, AllocFailed, ConfigFailed };

// ✅ DO - orelse for optional handling
const handle = c_api.create() orelse {
    c_api.cleanup();
    return ClientError.AllocFailed;
};
```

---

## Type System

### Type Casting

**Prefer explicit type annotations over inline casts.**

```zig
// ✅ DO
const width: u32 = @intCast(surface.w);
const text_width: f32 = @floatFromInt(size.w);
const x = rect.x + (rect.w - text_width) / 2.0;

// ❌ DON'T
const width = @as(u32, @intCast(surface.w));
const x = rect.x + (rect.w - @as(f32, @floatFromInt(size.w))) / 2.0;
```

### C Interop

```zig
// ✅ DO - Sentinel-terminated for C strings
pub fn connect(self: *Client, address: [*:0]const u8) !void {
    const result = c_api.connect(self.handle, address);
    if (result != C_OK) return ClientError.ConnectFailed;
}

// ✅ DO - Convert Zig strings to C strings
const address_z = try allocator.dupeZ(u8, address_slice);
defer allocator.free(address_z);
```

---

## Checklist

- [ ] ArrayList uses `.empty` syntax?
- [ ] Allocator passed explicitly?
- [ ] errdefer for multi-resource init?
- [ ] Type annotations instead of nested casts?
- [ ] Semantic variable names?

---

## Enforcement

**Automated:** `zig build` (compiler catches most issues)

**Code review:** Allocation strategy, errdefer usage, type casting clarity

---

## References

- [Zig 0.15.1 Docs](https://ziglang.org/documentation/0.15.1/)
- `carl/rules/subtract-first.md`

