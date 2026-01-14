# Comments

**Enforcement:** ⚠️ Partial automation (`carl check_comments` has false positives - use AI review instead)

## Principle

Comments explain **WHY**, not **WHAT**.

**Default: Zero comments.** Only add if:
1. Surprising behavior
2. Non-obvious constraint
3. Workaround
4. Security/performance consideration

**Delete if:**
- Narrates code
- Repeats names
- Tracks history (use git)

---

## Why

- Code should be self-documenting (good names, clear structure)
- Comments rot (code changes, comments don't)
- Log messages are better (visible at runtime, stay relevant)
- Less is more (fewer comments = higher signal-to-noise)

---

## Examples

### ✅ DO: Explain WHY

**Non-obvious decisions:**
```cpp
// Use deque for O(1) insertion at both ends (control + data plane)
std::deque<Message> queue_;
```

**Constraints:**
```cpp
// Must hold mutex_ when accessing connections_
std::vector<Connection*> connections_;
```

**Workarounds:**
```cpp
// Boost.Asio bug #12345: Must post to strand to avoid race
strand_.post([this] { handle_data(); });
```

### ❌ DON'T: Narrate Code

```cpp
// ❌ BAD
counter++;  // Increment counter

// ✅ GOOD
counter++;
```

### ❌ DON'T: Track History

```cpp
// ❌ BAD
// HttpClient Implementation (merged from ConnectionManager.cpp)
// Previously in NetworkLayer, moved to Transport layer

// ✅ GOOD (if needed at all)
// HttpClient handles HTTP/2 protocol negotiation and connection lifecycle
```

---

## Documentation Comments

**Public APIs MUST have doc comments.**

Follow language conventions:
- C/C++: Doxygen
- Zig: `///`
- Python: Docstrings

**Include:**
- Purpose
- Parameters, return value, errors
- Preconditions, postconditions
- Thread safety, blocking behavior

**Exclude:**
- Implementation details
- Obvious parameters
- Repeating function name

**Example:**
```cpp
/// Connect to remote server and establish session.
///
/// @param server_url Server address (e.g., "https://example.com")
/// @param timeout_ms Connection timeout in milliseconds
/// @return Session handle on success, error code on failure
/// @note Blocks until connection established or timeout
/// @thread_safety Thread-safe, can be called concurrently
int client_connect(const char* server_url, uint32_t timeout_ms);
```

---

## TODO/FIXME/HACK

**Format:**
```cpp
// TODO(username): Description - Issue #123
// FIXME(username): Description - Issue #456
// HACK(username): Description - Remove when X is fixed
```

**Always include:**
- Description (what needs doing)
- Issue number (if tracked)

---

## Style

**Use `//` not `/* */`** (unless language requires otherwise)

**Rationale:**
- Easier to comment out blocks
- Clearer visual separation
- Less nesting confusion

---

## Enforcement

**Automated (limited, has false positives):**
- `carl check_comments` - Detects obvious narration patterns
  - Simple patterns like "// Loop through", "// Increment"
  - **High false positive rate** - catches acceptable comments
  - Use as a rough indicator only

**AI Review (recommended):**
- Trigger: "review code" prompt
- AI can distinguish:
  - `// Create window` (narration) vs `// Create window (340x120 to match Qt version)` (explains WHY)
  - `// Update cache` (narration) vs `// Update cache to avoid stale data` (explains WHY)
  - Closing brace comments (acceptable) vs code narration (remove)

**Manual:**
- Code review: Challenge every comment
  - Does it explain WHY?
  - Can we delete it?
  - Can we improve code instead?

---

## Before Adding Any Comment

**Self-check:**
1. Does it explain WHY (not WHAT)? If NO → Delete it
2. Is it narrating code? If YES → Delete it
3. Is it tracking history? If YES → Use git instead
4. Can we improve code instead? If YES → Refactor, don't comment

**Prefer (in order):**
1. Better names (self-documenting)
2. Simpler code (obvious behavior)
3. Log messages (runtime visibility)
4. Comments (last resort)

---

## References

- Prefer log messages over comments (see logging.md)
- Public API documentation (see documentation.md)
- Self-documenting code (see subtract-first.md)

