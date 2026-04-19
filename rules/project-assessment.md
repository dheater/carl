# Project Assessment

**Enforcement:** Guideline for planning and evaluating projects

## Core Principles

1. **One-Person Team Size** — buildable by one person in ≤3 months. 2+ people = coordination cost > benefit. If you need >1 person, your component is too large. Rescope.
2. **Stable API Boundaries** — evolve additively; breaking changes allowed but rare (major version bump)
3. **Finished Components** — stable API + working implementation before moving on
4. **Reject Early** — validate with data in days/weeks, kill fast if wrong

## Planning-Phase Metrics

Use these, not SLOC. **If any fail → Rescope or kill.**

- API surface: ≤50 public symbols (≤20 for libraries)
- Dependencies: ≤5 runtime deps
- Modules: ≤10 files
- External interfaces: ≤3 external systems
- Finished criteria: writable in ≤5 bullets

## Decision Tree

```
Are components finished (stable API + working)?
├── YES → Rewrite viable (≤3 months with stable base)
└── NO  → STOP. Rescope (cut features) or Kill.
```

**Sunk cost test:** "Would we start this today?" If NO → Kill.

## Go/No-Go Points

| Checkpoint | Go | No-Go |
|------------|-----|-------|
| Week 1 | Prototype works, API stable, path clear | Kill or rescope |
| Week 2 | Core works, tests pass | Kill or rescope |
| Month 1 | Feature complete, only polish remains | Kill or rescope |
| Month 3 | DONE | Scrap and try again |

**Progress = working code, not effort. Partial = 0%.**

## Reject Ideas Early

Week 1: prototype, competitive analysis, data collection.

Questions: Real problem? Better than alternatives? Provable with data? What would make us kill this? **Any NO → Kill or rescope.**

## Checklists

**Planning:**
- [ ] One-person size (≤3 months)?
- [ ] All 5 planning metrics pass?
- [ ] Go/no-go points set (week 1, 2, month 1, 3)?
- [ ] Sunk cost test passes ("Would we start this today?")?

**Finish:**
- [ ] Stable API (documented, backward compatible)
- [ ] Tests pass, sanitizers pass (`carl check_all`)
- [ ] Documentation complete

**Kill (3+ YES → kill, salvage learnings):**
- [ ] No viable path to finish in 3 months
- [ ] Can't scope to one-person size
- [ ] Sunk cost test fails ("Would we NOT start this today?")

## Integration

```bash
carl check_deps      # ≤5 runtime dependencies
carl check_abi       # No breaking changes
carl check_all       # All checks
zig build test -Dsanitize=address,undefined,thread
```

