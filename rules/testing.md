# Testing

**Enforcement:** ✅ Automated (`carl check_tests` detects test file presence)

**TODO:**
- Detect missing tests for new features (new functions without tests)
- Detect test coverage gaps

**Will NOT enforce:**
- Test coverage percentage (arbitrary threshold)
- Flaky tests (hard to detect automatically)

## Principle

Sanitizers (ASan/UBSan/TSan) on all tests. Fuzzers for parsers/decoders. Golden tests for invariants. Property-based tests over exhaustive examples. Test at seams, not internals.

---

## Why

- **Sanitizers catch bugs** - Memory errors, UB, races
- **Fuzzers find edge cases** - Automated input exploration
- **Golden tests verify invariants** - Stable error codes, ordering, idempotence
- **Property tests scale** - One property > 100 examples
- **Seam tests survive refactoring** - Internal changes don't break tests

---

## Sanitizers

```bash
# Always run with sanitizers
zig build test -Dsanitize=address    # Memory errors
zig build test -Dsanitize=undefined  # UB
zig build test -Dsanitize=thread     # Races
zig build test -Dsanitize=memory     # Uninitialized reads
```

**CI:** Run all tests with each sanitizer in matrix

---

## Fuzzing

**Always fuzz:** Parsers, decoders, handshakes, input validation

```zig
export fn LLVMFuzzerTestOneInput(data: [*]const u8, size: usize) c_int {
    _ = parser.parse(data[0..size]) catch return 0;
    return 0;
}
```

**CI:** Short run (60s) in CI, long run (1hr) nightly. Version control minimal corpus.

---

## Golden Tests

**Test invariants:** Ordering, idempotence, error mapping, serialization round-trips

```zig
// Error codes are stable
test "error codes stable" {
    const golden = @embedFile("golden/error_codes.txt");
    const current = try generateErrorCodeMapping();
    try std.testing.expectEqualStrings(golden, current);
}

// Idempotence
test "connect idempotent" {
    var ctx = try lib_create_context();
    defer lib_destroy_context(ctx);
    try lib_connect(ctx, "example.com");
    const state1 = lib_get_state(ctx);
    try lib_connect(ctx, "example.com");
    try std.testing.expectEqual(state1, lib_get_state(ctx));
}
```

---

## Property-Based Testing

**One property > 100 examples**

```zig
// ✅ DO: Property test
test "base64 round-trip" {
    var prng = std.rand.DefaultPrng.init(0);
    var i: usize = 0;
    while (i < 1000) : (i += 1) {
        var input: [256]u8 = undefined;
        prng.random().bytes(&input);
        try std.testing.expectEqualSlices(u8, &input, try decode(try encode(&input)));
    }
}
```

**Properties:** Round-trip, inverse, commutativity, associativity

---

## Test at Seams

| ❌ DON'T | ✅ DO |
|----------|-------|
| Test internal buffer management | Test public API (create, connect, send) |
| Test private helper functions | Test observable behavior at boundaries |

**Why:** Seam tests survive refactoring

---

## Checklist

- [ ] Tests for public API?
- [ ] Sanitizers enabled? (ASan/UBSan/TSan)
- [ ] Fuzz targets for parsers?
- [ ] Golden tests for invariants?
- [ ] Property tests where applicable?
- [ ] Error paths tested?

---

## Enforcement

**Automated:**
- `carl check_tests` - Detect test file presence (FAIL if 0 test files)
- `carl check-ci-config` - Verify sanitizers in CI (TODO)
- `carl check-fuzz-coverage` - Verify fuzz targets (TODO)

**Code review:** Tests added? Sanitizers enabled? Fuzz targets for parsers?

---

## References

- `plans/native-c-api-stability-plan.md`
- `carl/rules/api-stability.md`

