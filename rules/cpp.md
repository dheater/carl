# C++ Guidelines

**Enforcement:** Language-specific guidelines (not automated, use clang-tidy/cppcheck)

## Principle

C++17 only. Public API is C-only (no C++ features). Internal code: RAII everywhere, const correctness, smart pointers, no raw new/delete. Think like Rust's borrow checker.

---

## Why

- **C ABI is universal** - Language-agnostic, stable across compilers
- **RAII prevents leaks** - Automatic cleanup, exception-safe
- **Const correctness prevents bugs** - Immutability by default
- **Smart pointers clarify ownership** - Who owns what, when freed
- **Thread safety requires discipline** - Async code needs lifetime management

---

## Public API (include/)

**C-only. No C++ features.**

| ❌ DON'T | ✅ DO |
|----------|-------|
| `class Session { ... };` | `typedef struct Session* SessionHandle;` |
| `std::string getMessage()` | `const char* lib_get_message(Handle h)` |
| `throw std::runtime_error(...)` | `return ERROR_INVALID_ARGS;` |

**Rules:** `extern "C"` linkage, opaque pointers, C types only, error codes not exceptions, `#pragma once`

---

## Internal Code (src/)

### Memory Management

**RAII everywhere. No raw new/delete.**

| ❌ DON'T | ✅ DO |
|----------|-------|
| `Session* s = new Session();` | `auto s = std::make_shared<Session>();` |
| `char* buf = (char*)malloc(size);` | `auto buf = std::make_unique<char[]>(size);` |

### Smart Pointers

| Use Case | Type |
|----------|------|
| Exclusive ownership | `std::unique_ptr` |
| Shared ownership | `std::shared_ptr` (use sparingly) |
| Non-owning | Raw pointer/reference |

**Async:** Capture `shared_ptr` to extend lifetime, never capture raw `this`.

```cpp
// ✅ DO
void Session::asyncRead() {
    auto self = shared_from_this();
    asio::async_read(socket_, buffer_, [self](error_code ec, size_t bytes) {
        self->handleRead(ec, bytes);
    });
}

// ❌ DON'T - Use-after-free risk
void Session::asyncRead() {
    asio::async_read(socket_, buffer_, [this](error_code ec, size_t bytes) {
        this->handleRead(ec, bytes);  // DANGER!
    });
}
```

### Const Correctness

**Immutability by default.**

```cpp
// ✅ DO
std::string getHost() const { return host_; }
void setHost(const std::string& host) { host_ = host; }

// ❌ DON'T
std::string getHost() { return host_; }  // Missing const!
void setHost(std::string host) { host_ = host; }  // Unnecessary copy!
```

### Thread Safety

**Protect shared state. Use mutex or atomic.**

```cpp
// ✅ DO
class ThreadSafeQueue {
    std::mutex mutex_;
    std::queue<Item> queue_;
public:
    void push(Item item) {
        std::lock_guard<std::mutex> lock(mutex_);
        queue_.push(std::move(item));
    }
};

// ❌ DON'T - Race condition
class ThreadSafeQueue {
    std::queue<Item> queue_;  // NO MUTEX!
public:
    void push(Item item) { queue_.push(std::move(item)); }
};
```

### Error Handling

- Exceptions for exceptional conditions
- Error codes for expected failures (async)
- `std::optional` for "not found"

---

## Checklist

**Public API (include/):**
- [ ] C-only? `extern "C"`? Opaque pointers? Error codes?

**Internal code (src/):**
- [ ] RAII? Smart pointers? Const correctness? Thread safety? Async lifetimes?

---

## Enforcement

**Automated:** Compiler warnings, clang-tidy

**Code review:** RAII, const correctness, ownership, thread safety

---

## Compiler Flags

**Common:** `-Wall -Wextra -Wpedantic -Wconversion -Wsign-conversion -Wshadow -Wcast-qual -Wcast-align`

**C-only:** `-Wstrict-prototypes -Wmissing-prototypes`

**C++-only:** `-Wnon-virtual-dtor -Wold-style-cast -Woverloaded-virtual -Wdeprecated-copy-dtor`

Enable all in dev. Treat as errors in CI (`-Werror`). Disable specific only when necessary.

