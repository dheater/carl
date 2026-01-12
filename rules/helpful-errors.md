# Helpful Errors

**Enforcement:** Project-specific (compilers, parsers, validators should implement)

## Principle

Error messages teach, not just report. Include: what failed, why it matters, how to fix it. Fail fast by default. Add recovery only for specific, recurring failures with explicit, bounded, testable logic.

---

## Why

- **Errors are teaching moments** - Help users fix problems themselves
- **Debugging time matters** - Clear errors save hours
- **Fail fast prevents cascades** - Early failure is easier to diagnose
- **Recovery hides bugs** - Automatic retry masks root causes

---

## Error Message Structure

### Template

```
[WHAT] specific operation that failed
[WHY] why this matters / what was expected
[HOW] actionable fix or next step
[CONTEXT] relevant details (codes, values, paths)
```

### Examples

| ❌ DON'T | ✅ DO |
|----------|-------|
| `error: Invalid` | `error: Cannot use []Type as comptime value. Use: const x: []const T = &[_]T{a, b};` |
| `Connection failed` | `SSH_AUTH_FAILED: Public key rejected by server 10.0.1.50. Check: ~/.ssh/id_rsa permissions (should be 0600)` |
| `Parse error` | `JSON parse error at line 42, column 15: Expected '}' but found ','. Missing closing brace for object starting at line 38.` |
| `File not found` | `Config file not found: /etc/app/config.json. Create it with: cp config.example.json /etc/app/config.json` |

---

## Error Codes

```c
// Stable integer codes (never change)
typedef int32_t lib_err_t;
#define LIB_OK 0
#define LIB_ERR_NETWORK -1
#define LIB_ERR_AUTH -2

// Human-readable
const char* lib_strerror(lib_err_t code);

// Optional: per-handle context
typedef struct LibError { lib_err_t code; char message[256]; } LibError;
int lib_get_last_error(lib_ctx ctx, LibError* err);
```

---

## Fail Fast vs Recovery

**Default: Fail fast**
```zig
fn connect(host: []const u8) !Connection {
    return Connection{ .socket = try openSocket(host) };
}
```
**Why:** Easier to debug, no hidden state corruption, caller controls retry

**Recovery: Explicit, bounded, testable**
```zig
fn connectWithRetry(host: []const u8, max_attempts: u32) !Connection {
    var attempts: u32 = 0;
    while (attempts < max_attempts) : (attempts += 1) {
        if (connect(host)) |conn| return conn else |err| {
            if (attempts + 1 >= max_attempts) return err;
            std.time.sleep(std.time.ns_per_s * attempts);
        }
    }
    return error.MaxRetriesExceeded;
}
```

**Add recovery only if:** Specific recurring failure, bounded attempts/timeout, explicit backoff, testable, caller can opt out

---

## Checklists

**Error messages:**
- [ ] What failed? Why? How to fix? Context included?
- [ ] User can fix without reading source?
- [ ] Error code stable?

**Error recovery:**
- [ ] Specific recurring failure? Bounded? Explicit backoff?
- [ ] Testable? Caller can opt out? Fails fast if exhausted?

---

## Enforcement

**Automated:** `carl check-error-codes`, `carl lint-errors`

**Code review:** Errors helpful? Teach? Can fix without reading source?

---

## References

- `plans/native-c-api-stability-plan.md`
- `carl/rules/subtract-first.md`

