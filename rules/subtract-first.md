# Subtract First

**Enforcement:** Guideline for AI and code review (not automated)

## Principle

Default response to any proposal:
1. What can we delete?
2. What can we simplify?
3. What can we reuse?
4. Only then: what do we add?

Prefer: **Delete → Simplify → Reuse → Add (last resort)**.

---

## Why

- **Features are liabilities** - Maintenance, complexity, bugs
- **Dependencies are liabilities** - Security, compatibility, build time
- **Code is a liability** - More to read, test, debug
- **Less code = less to break**

Every line of code you don't write is a line you don't have to maintain, debug, or explain.

---

## Examples

### Example 1: Bundling Dependencies

**Proposal:** "Bundle compiler in our build tool"

**Subtract-first response:**
1. **Delete:** Users can install compilers themselves
2. **Why:** Bundling adds ~100MB+, maintenance burden, version conflicts
3. **Decision:** Delete this idea

### Example 2: Configuration

**Proposal:** "Add a config file for settings"

**Subtract-first response:**
1. **Simplify:** Can environment variables suffice? CLI flags?
2. **Why:** Config files add I/O, parsing, validation, error paths
3. **Decision:** Use env vars unless config is essential

### Example 3: Error Recovery

**Proposal:** "Add automatic retry logic for failed connections"

**Subtract-first response:**
1. **Simplify:** Can we fail fast and let caller retry?
2. **Why:** Recovery code is where bugs hide; bounded retry is complex
3. **Decision:** Fail fast unless specific, bounded retry is proven necessary

### Example 4: Abstractions

**Proposal:** "Create a generic data access layer"

**Subtract-first response:**
1. **Reuse:** Do we have 3+ concrete use cases?
2. **Why:** Premature abstraction is harder to change than duplication
3. **Decision:** Duplicate until pattern emerges (3+ uses)

---

## Challenge Everything

**Question:**
- **Dependencies:** Do we need this? Can we duplicate/vendor instead?
- **Abstractions:** Do we have 3+ real uses? Or is this premature?
- **Features:** Is this solving a real, observed problem?
- **Complexity:** Can we delete half of this and still meet needs?

**Abstraction rule:** No new abstraction without 3 real uses and proof it reduces total code/complexity versus duplication.

---

## Practical Rules

### Code Review

Each change must call out what was deleted/simplified/reused before additions:

```
feat(api): add capability negotiation

Deleted:
- Removed api_level versioning (100 LOC)

Simplified:
- Replaced version checks with feature bits

Reused:
- Existing size'd struct pattern

Added:
- lib_get_capabilities() function (20 LOC)
```

### Surface Area

- Keep interfaces small and cohesive
- Avoid micro-libraries (prefer cohesive modules)
- Avoid convenience wrappers as public dependencies
- Fewer modes and flags preferred

### Error Handling

- Fail fast by default
- Add recovery only for specific, recurring failures
- Recovery must be explicit, bounded, and testable
- No hidden error handling

### Visibility

- Allocations are explicit in names and docs
- Blocking/I/O is explicit
- Ownership is documented
- No hidden control flow

---

## Enforcement

**Not automatable.** Apply during:

- **Code review:** What was deleted/simplified/reused first?
- **Design review:** What alternatives were considered?
- **Commit messages:** Justify additions, celebrate deletions

**Review checklist:**
- [ ] What was deleted?
- [ ] What was simplified?
- [ ] What was reused?
- [ ] Are additions justified?
- [ ] Can we delete more?

---

## Light Evidence > Heavy Metrics

**Prefer qualitative evidence:**
- Fewer modes
- Fewer dependencies
- Smaller diffs
- Shorter code paths
- Simpler control flow

**Quantitative when easy:**
- Latency/throughput/memory/CPU if trivial to gather
- Don't delay deletion/simplification awaiting lab-grade numbers

**Example:** Small, qualitative improvements over time beat elaborate benchmarking.

---

## Where This Connects

- **Dependencies:** Keep external runtime deps ≤5; duplication over unnecessary deps
- **API Stability:** Add-only evolution; breaking changes allowed but rare (major version bump)
- **Portability:** Broad, boring compatibility; avoid platform-specific feature creep
- **Metrics/SLOs:** Optional thresholds; use measurements to validate, not justify complexity

---

## References

**Eskil Steenberg:**
- Simplicity over complexity
- Control over convenience
- Understanding over abstraction
- Small products (sized for 1 person)

**Andrew Kelly (Zig):**
- Explicit over implicit
- No hidden control flow
- No hidden allocations
- Simple over clever

**Casey Muratori:**
- Compression-oriented programming
- Delete code, don't add it
- Complexity is the enemy
- Features are liabilities

