# Dependencies & Seams

**Enforcement:** Guideline (not enforced - context-dependent)

**What `carl check_deps` detects:**
- CMake: `find_package()` calls in CMakeLists.txt
- Zig: `build.zig.zon` dependencies + `exe.linkSystemLibrary()`
- Rust: `[dependencies]` and `[build-dependencies]` in Cargo.toml
- Conan: `[requires]` in conanfile.txt

**TODO:**
- Detect version pinning violations (lock files out of sync)

**Will NOT parse:**
- Dependency count (≤5 is a guideline, not a hard rule - informational only)
- conanfile.py (too complex, use `conan graph info`)
- package.json (use `npm list`)
- requirements.txt (use `pip list` or `pipdeptree`)
- Transitive dependencies (use native tools)

## Principle

Runtime dependencies ≤5 per project (excluding OS/stdlib). Prefer: **Duplicate (≤200 LOC) → Vendor → Static → Dynamic (last resort)**. All runtime libraries expose stable C ABIs. Process seams for isolation; library seams for performance.

---

## Why

- **Dependencies are liabilities** - Security, compatibility, build complexity
- **Fewer dependencies = simpler builds** - Offline, reproducible builds
- **Duplication is often cheaper** - For small, stable utilities
- **C ABI is universal** - Language-agnostic boundary

---

## Dependency Budget

**Hard limit:** ≤5 external runtime dependencies per project (excluding OS/stdlib)

### Decision Tree

```
Need functionality?
  Can duplicate? (≤200 LOC, low risk, 1-2 consumers)
    YES → Duplicate
    NO  → Can vendor? (header-only or source C library)
      YES → Vendor
      NO  → Can static link?
        YES → Static link
        NO  → Essential?
          YES → Dynamic link (justify in docs)
          NO  → Redesign without it
```

### Approved Exceptions

| Dependency | Policy | Why |
|------------|--------|-----|
| **TLS/Crypto** | Dynamic link to system libs | Security updates, FIPS compliance |

---

## Library Boundary Rule

**All runtime libraries must expose stable C ABI:**
- Zig may be used internally
- Public boundary is C (opaque handles, size'd structs, error codes)
- Evolve additively; breaking changes allowed but rare (major version bump)
- Maintain LTS for old major versions during migration

---

## Seams Without Sprawl

### When to Use Process Seams
- Fault isolation (crash doesn't kill parent)
- Upgrade isolation (restart component independently)
- Language freedom (different runtime/GC)
- Contain dependency trees (isolate heavy deps)

### When to Use Library Seams
- In-process performance (avoid IPC overhead)
- Shared memory access
- Tight coupling acceptable

### Design Principles
- **Thin interface, cohesive module** - Narrow API, functionality together
- **Avoid micro-libraries** - Keep related code in one module
- **Add-only evolution** - New functions/flags/fields; never change defaults

---

## Offline, Reproducible Builds

**Requirements:**
- Pin versions (lock files, vendored sources)
- Local caches (Nix store, Zig cache, Artifactory)
- One-time fetch to populate cache → thereafter offline
- No network fetch during build (after cache populated)

**CI validation:**
```bash
# Validate offline build path
rm -rf ~/.cache
./build.sh --offline  # Must succeed after initial cache
```

---

## Checklists

**Before adding dependency:**
- [ ] Can duplicate (≤200 LOC)? Can vendor? Essential?
- [ ] Fits budget (≤5)? Stable? Supports platforms? Offline build?

**Before creating seam (write one-pager):**
- Purpose, operations, invariants, error rules, threading/lifetime

---

## Enforcement

**Automated:** `carl check_deps`, `carl check_offline_build` (not yet implemented)

**Code review:** Dependency justified? Alternatives considered? One-pager for seams? Budget respected?

---

## References

- `plans/dependencies-and-seams-charter.md`
- `carl/rules/subtract-first.md`
- `carl/rules/api-stability.md`

