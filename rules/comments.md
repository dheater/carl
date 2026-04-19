# Comments

**Enforcement:** ⚠️ Partial automation (`carl check_comments` has false positives - use AI review instead)

## Principle

Comments explain **WHY**, not **WHAT**.

**Default: Zero comments.** Only add if: surprising behavior, non-obvious constraint, workaround, security/performance consideration.

**Delete if:** narrates code, repeats names, tracks history (use git).

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

**Public APIs MUST have doc comments** (C/C++: Doxygen, Zig: `///`, Python: docstrings).

Include: purpose, parameters, return value, errors, thread safety, blocking behavior. Exclude: implementation details, obvious parameters.

```cpp
/// Connect to remote server and establish session.
/// @param server_url Server address (e.g., "https://example.com")
/// @param timeout_ms Connection timeout in milliseconds
/// @return Session handle on success, error code on failure
/// @thread_safety Thread-safe
int client_connect(const char* server_url, uint32_t timeout_ms);
```

---

## TODO/FIXME/HACK

```cpp
// TODO(username): Description - Issue #123
// FIXME(username): Description - Issue #456
// HACK(username): Description - Remove when X is fixed
```

---

## Style

Use `//` not `/* */`. Easier to comment out blocks, clearer separation.

---

## Enforcement

**Automated (limited):** `carl check_comments` — high false positive rate, rough indicator only.

**AI Review:** "review code" prompt — AI can distinguish narration from WHY explanations.

**Before adding any comment:** Does it explain WHY? If NO → Delete. Can we improve code instead? If YES → Refactor.

