# Project Assessment

**Enforcement:** Guideline for planning and evaluating projects

## Core Principles

**1. One-Person Team Size** - Any component should be buildable by one person in ≤3 months

**Why one person:**
- 2 people = 2x time (coordination cost)
- 3 people = 2.2x time
- 4 people = 1.5x (as 2 independent pairs)
- 5+ people = ∞ (will never get done)

This doesn't mean that having people work together is wrong. You get knowledge sharing, varying ideas.
Just know that it will be slower.

**If you need >1 person, your component is too large. Rescope.**

**2. Stable API Boundaries** - Evolve additively; breaking changes allowed but rare (major version bump)

**3. Finished Components** - Stable API + maintained implementation before moving on

**4. Reject Early** - Validate with data in days/weeks, kill fast if wrong

## Planning-Phase Metrics (Before Writing Code)

**Use these, not SLOC:**

1. **API surface:** ≤50 public symbols (≤20 for libraries)
2. **Dependencies:** ≤5 runtime deps (`carl check_deps`)
3. **Modules:** ≤10 files
4. **External interfaces:** ≤3 external systems
5. **Finished criteria:** Can write in ≤5 bullets?

**If any metric fails → Rescope or kill**

## Decision Tree: Rewrite vs Rescope vs Kill

```
Are components finished (stable API + working)?
├── YES → Stable components to build on?
│   ├── YES → Rewrite viable (≤3 months)
│   └── NO → Build stable components first
│
└── NO → STOP. Rescope or kill.
    ├── Viable plan to finish? → Rescope (cut features)
    └── No viable plan? → Kill (sunk cost fallacy)
```

**Sunk cost test:** "If we hadn't started, would we start today?" If NO → Kill.

## Go/No-Go Decision Points

**Measure real progress, not effort:**

```
Week 1: Prototype + validate
├── Go: Prototype works, API stable, path clear
└── No-Go: Kill or rescope

Week 2: Core implementation
├── Go: Core works, tests pass
└── No-Go: Kill or rescope

Month 1: Feature complete
├── Go: All features work, only polish remaining
└── No-Go: Kill or rescope

Month 3: DEADLINE
├── Done: Ship it
└── Not done: Screwed up - scrap and try again
```

**At each point:** Sunk cost test + data-driven decision

**Progress = working code, not effort.** Partial completion = 0%.

## Reject Ideas Early

**Week 1 validation methods:**

1. **Vera** - Simulate expert opinions (see `skills/vera.md`)
2. **Prototype** - Build minimal version, test core idea
3. **Competitive analysis** - Does existing solution win?
4. **Data collection** - Measure key metrics

**Questions:**
- Does this solve a real problem?
- Is solution better than alternatives?
- Can we prove with data?
- What would make us kill this?

**If any NO → Kill or rescope**

**Example (Zai):** 2 weeks, 3 experiments, data showed Zig equal/better → killed. Salvaged: build system helper, research, recommendations.

## Checklists

### Planning Checklist

- [ ] One-person size (≤3 months)?
- [ ] API surface ≤50 symbols?
- [ ] Dependencies ≤5?
- [ ] Modules ≤10?
- [ ] External interfaces ≤3?
- [ ] Finished criteria ≤5 bullets?
- [ ] Go/no-go points set (week 1, 2, month 1, 3)?
- [ ] Sunk cost test: "Would we start this today?"

**If any NO → Rescope or kill before writing code**

### Week 1 Review

- [ ] Prototype works (demonstrates core idea)
- [ ] API stable (defined and documented)
- [ ] Path to finish clear (no unknowns)
- [ ] Dependencies stable
- [ ] Sunk cost test passes

**Go:** Proceed | **No-Go:** Kill or rescope

### Week 2 Review

- [ ] Core functionality works
- [ ] Tests passing
- [ ] API stable
- [ ] Real progress visible (working code)
- [ ] Sunk cost test passes

**Go:** Proceed | **No-Go:** Kill or rescope

### Month 1 Review

- [ ] All features work (feature complete)
- [ ] API stable
- [ ] Tests passing
- [ ] Only polish remaining
- [ ] Sunk cost test passes

**Go:** Proceed | **No-Go:** Kill or rescope

### Month 3 Review (DEADLINE)

- [ ] Component DONE (stable API + working + tests pass)
- [ ] `carl check_all` passes
- [ ] Sanitizers pass
- [ ] Documentation complete

**If all YES:** Ship | **If any NO:** Screwed up - scrap and try again

**Exception:** Working shippable subset? Ship subset, kill rest.

### Finish Checklist

- [ ] Stable API (documented, backward compatible)
- [ ] Working implementation (tests pass)
- [ ] Sanitizers pass (ASan, UBSan, TSan)
- [ ] `carl check_all` passes
- [ ] Documentation complete

### Kill Decision Checklist

- [ ] No viable plan to finish in 3 months
- [ ] Can't scope to one-person size
- [ ] Sunk cost test fails: "Would we NOT start this today?"
- [ ] More valuable to start fresh

**If 3+ YES → Kill it. Salvage learnings.**

## Integration with Carl

**During planning:** Use planning-phase metrics (no automated checks)

**During implementation:**
```bash
carl check_deps      # ≤5 runtime dependencies
carl check_abi       # No breaking changes
carl check_all       # Run all checks
```

**Before "finished":**
```bash
carl check_all
zig build test -Dsanitize=address,undefined,thread
```

## Related

- `rules/subtract-first.md` - Delete before adding
- `rules/dependencies.md` - Dependency budget (≤5)
- `rules/api-stability.md` - Stable APIs
- `skills/vera.md` - Early validation technique

