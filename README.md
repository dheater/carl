# Carl: Development Principles for Stable Systems

**Opinionated development contracts for C/C++/Zig systems programming.**

---

## Install

```bash
git clone https://github.com/carl-lang/carl.git
cd carl
./install.sh
```

This symlinks individual Carl rules to `~/.augment/rules/` for AI integration.

---

## Quick Start

```bash
# Check your project
carl check_deps      # Dependency budget (≤5 runtime deps)
carl check_abi       # ABI stability (no breaking changes)
carl check_commits   # Conventional commits
carl check_all       # Run all checks
```

---

## Why Carl Exists

**The problem:**
- APIs break constantly
- Dependencies are out of control
- Code is too complex
- Documentation overwhelms users

**The solution:**
- **Subtract first** - Delete before adding
- **Stable APIs** - No breaking changes under same name
- **Dependency budget** - ≤5 runtime deps
- **Helpful errors** - Teach, don't just report
- **Structured logging** - Queryable, actionable
- **Enforceable** - Tools check compliance

---

## Core Philosophy

### 1. Subtract First

**Default response to any proposal:**
1. What can we delete?
2. What can we simplify?
3. What can we reuse?
4. Only then: what do we add?

**Prefer:** Delete → Simplify → Reuse → Add (last resort)

### 2. Stability as a Promise

- **CalVer** (YYYY.MM.PATCH)
- **No breaking changes** under same name
- **Add-only evolution** (new functions/flags/fields)
- **Incompatible redesign?** Ship as new product (new name)

### 3. Explicit Over Implicit

- No hidden allocations
- No hidden control flow
- No hidden I/O
- Ownership is documented

### 4. Helpful Errors

Errors should teach, not just report:
- What went wrong (specific)
- Why it matters (rationale)
- How to fix it (actionable)
- Example of correct usage

---

## The Contracts

### API Stability Contract

**Principle:** No breaking changes under same name. Incompatible redesigns ship as new products.

**Rules:**
- CalVer versioning (YYYY.MM.PATCH)
- Add-only evolution (new APIs, unchanged defaults)
- Capability negotiation (feature bits, not api_level)
- Opaque handles, size'd structs, stable error codes

**Enforcement:** `carl check_abi`

**See:** `rules/api-stability.md`

### Dependency Budget Contract

**Principle:** Limit runtime dependencies to ≤5 per project.

**Decision tree:**
```
Can you duplicate it? (≤200 LOC, low risk)
  YES → Duplicate
  NO  → Can you vendor it? (header-only, source)
    YES → Vendor
    NO  → Is it essential? (TLS, crypto, UI)
      YES → Add (justify in commit)
      NO  → Redesign to avoid
```

**Enforcement:** `carl check_deps`

**See:** `rules/dependencies.md`

### Portability Contract

**Principle:** Broad, boring compatibility. Support matrix:
- Linux: glibc ≥2.28, x86_64/arm64
- Windows: 10 22H2+, x64/arm64
- macOS: 11+, x86_64/arm64

**Rules:**
- Runtime feature detection
- Pinned toolchains, reproducible builds
- CI matrix: oldest + latest per platform

**Enforcement:** CI smoke tests on support matrix

**See:** `rules/portability.md`

---

## Practices

### Helpful Error Messages

**Principle:** Errors teach, not just report.

**Include:**
- What went wrong
- Why it matters
- How to fix it
- Example

**See:** `rules/helpful-errors.md`

### Structured Logging

**Principle:** Queryable, actionable logs.

**Format:** Multi-line key=value
- All events: timestamp, event_id
- Failures: session_id, full context
- Success: minimal fields

**See:** `rules/logging.md`

### Comments & Documentation

**Principle:** Explain WHY, not WHAT. Default to zero comments.

**Comments:** Only for surprising behavior, constraints, workarounds
**Docs:** Only when explicitly requested

**Enforcement:** `carl check_comments`, `carl check_docs`

**See:** `rules/comments.md`, `rules/documentation.md`

### Code Review

**Principle:** Delete first, simplify second, add last.

**Focus:**
- Dead code (unused imports, functions, commented code)
- Duplication (copy-pasted logic, repeated patterns)
- Unnecessary comments (narration, obvious statements)
- Simplification opportunities (merge functions, simpler types)
- Type system vs runtime checks (make invalid states unrepresentable)

**Trigger:** "carl review" or "review code"

**See:** `rules/review-code.md`

### Intern Protocol

**Principle:** Reset when stuck. Stop, think from first principles, try simpler.

**Use when:**
- Same approach failing repeatedly
- Going in circles
- Overengineering
- Adding complexity instead of removing it

**Trigger:** "hey intern"

**See:** `rules/intern-protocol.md`

---

## Tooling

Carl provides automated checks:

- `carl check_deps` - Dependency budget (≤5)
- `carl check_abi` - ABI stability (abidiff, nm, otool)
- `carl check_commits` - Conventional commits
- `carl check_exports` - Symbol visibility
- `carl check_comments` - Narration detection
- `carl check_docs` - Unsolicited .md files
- `carl check_logs` - Structured logging
- `carl check_all` - Run all checks

**Output:** JSON (parseable by AI/CI)
**Exit code:** 0 (advisory, not blocking)

---

## For AI Integration

Carl rules are designed for LLM consumption.

**Location:** Individual rules symlinked to `~/.augment/rules/`

**Core rules** (always loaded):
- 00-CRITICAL-CARL.md
- subtract-first.md
- git-policy.md
- api-stability.md
- dependencies.md
- helpful-errors.md
- logging.md
- portability.md
- metrics-slos.md
- testing.md
- comments.md
- documentation.md
- ephemeral-scripts.md
- review-code.md
- intern-protocol.md
- writing-skills.md

**Language-specific** (loaded on-demand):
- cpp.md
- zig.md
- just.md

### User-Specific Skills

Carl rules are generic and open-source. For tool-specific or work-specific knowledge, use `~/.augment/rules/skills/`:

```
~/.augment/rules/
├── 00-CRITICAL-CARL.md      # Carl rules (symlinked)
├── api-stability.md          # Carl rules (symlinked)
├── ...                       # More Carl rules
└── skills/                   # User-specific (NOT part of Carl)
    └── tools/
        └── jira/             # Tool-specific knowledge
            ├── skill.md
            ├── assets/
            └── references/
```

**Why separate?**
- Carl: Generic coding principles, open-source ready
- Skills: Tool-specific knowledge, work-specific workflows, personal preferences

**Adding skills:**
```bash
cp -r ~/my-skills/jira ~/.augment/rules/skills/tools/
```

Augment loads all .md files from `~/.augment/rules/` recursively, so skills work alongside Carl without being part of Carl.

---

## Adoption

**Start small:**
1. Pick one contract (e.g., dependency budget)
2. Run `carl check_deps`
3. Fix violations
4. Add to CI
5. Repeat with next contract

**Incremental adoption is fine.** You don't need to adopt all contracts at once.

---

## References

- **Rules:** `~/.augment/rules/` (symlinked from Carl repo)
- **Tools:** `carl` (Zig implementation)
- **Source:** https://github.com/carl-lang/carl

**Inspired by:**
- Eskil Steenberg (simplicity, control, understanding, ABI compatibility)
- Andrew Kelly / Zig (explicit over implicit, simple over clever)
- Casey Muratori (compression-oriented programming, delete code)

---

## License

MIT

