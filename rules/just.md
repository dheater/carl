# Just Command Runner Guidelines

**Enforcement:** Language-specific guidelines (not automated, manual review)

## Principle

Just is NOT Make or Bash. Use Just's expression language for conditionals, string manipulation, platform detection. Bash is an escape hatch for complex pipelines only. POSIX commands in recipe bodies, not bash-isms.

---

## Why

- **Just has its own language** - Conditionals, functions, string ops built-in
- **Bash is an escape hatch** - For when Just can't do something
- **POSIX is portable** - Bash-specific syntax breaks portability
- **Declarative > imperative** - Justfile should read like a build spec

---

## Core Patterns

| Pattern | ✅ DO | ❌ DON'T |
|---------|-------|----------|
| **Conditionals** | `{{ if SAN == "asan" { "-fsanitize=address" } else { error("Unknown") } }}` | `#!/usr/bin/env bash`<br>`case "{{SAN}}" in ...` |
| **Platform** | `if os() == "macos" { "arm" } else { "x86" }` | `` `uname -s` `` |
| **Strings** | `"release-" + version + ".tar.gz"` | `` `echo "release-${VERSION}.tar.gz"` `` |
| **Paths** | `config_dir() / ".config"` | `"$HOME/.config"` |
| **Validation** | `{{ if ENV != "prod" { error("Must be prod") } else { "" } }}` | `@[[ "{{ENV}}" == "prod" ]] \|\| exit 1` |
| **POSIX** | `@test -x build/test \|\| exit 1` | `@if [[ ! -x build/test ]]; then ...` |

**Functions:** `os()`, `arch()`, `env_var(name)`, `env_var_or_default(name, default)`, `error(message)`

**Operators:** `+` (concat), `/` (path join), `==`, `!=`, `&&`, `||`, `=~` (regex)

---

## Recipe Organization

```just
# ✅ DO - Dependencies, private helpers, variables
build_type := env_var_or_default('BUILD_TYPE', 'Release')

# Run all tests
test: build
    cargo test

build: _setup
    cmake -B build -DCMAKE_BUILD_TYPE={{build_type}}

[private]
_setup:
    mkdir -p build

# ❌ DON'T - Manual sequencing, public helpers, repeated strings
test:
    just build
    cargo test

build:
    cmake -B build -DCMAKE_BUILD_TYPE=Release
```

**Private recipes:** Prefix `_` OR `[private]`. Don't appear in `just --list`.

**Doc comments:** `#` directly above recipe. Appear in `just --list`.

---

## When to Use Bash

**Escape hatch only.** Use for complex pipelines, loops, advanced string manipulation.

```just
# ✅ ACCEPTABLE - Complex pipeline
publish:
    VERSION=$(sed -En 's/version.*"([^"]+)"/\1/p' Cargo.toml | head -1)
    git tag -a $VERSION -m "Release $VERSION"

# ❌ DON'T - Simple conditional (use Just!)
test SAN:
    #!/usr/bin/env bash
    if [ "{{SAN}}" = "tsan" ]; then cmake --build build -j1; fi

# ✅ DO - Just expression
test SAN:
    cmake --build build {{ if SAN == "tsan" { "-j1" } else { "" } }}
```

---

## Decision Tree

```
Need control flow?
  Simple conditional/string op? → Just expression language
  Complex pipeline/loop? → Bash (escape hatch)

Platform detection? → os() / arch()

Environment variable?
  Has default? → env_var_or_default('VAR', 'default')
  No default? → env_var('VAR')
```

---

## Checklist

- [ ] Can use Just expression language instead of bash?
- [ ] POSIX commands (not bash-isms)?
- [ ] Variables for repeated values?
- [ ] Private recipes for helpers?
- [ ] Doc comments for public recipes?
- [ ] `@` for silent messages?

---

## Enforcement

**Code review:** Check for unnecessary bash, bash-isms, missing doc comments

**Test:** Run on different shells to verify POSIX compatibility

---

## References

- [Just Manual](https://just.systems/man/en/)
- `carl/rules/subtract-first.md`

