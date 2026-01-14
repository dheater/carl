# Plan Template

**Use this template for all project plans and proposals.**

**Goal:** Make plans automatically analyzable by AI and `carl check_plan` (future).

---

## Metadata

**Project:** [Name]  
**Author:** [Your name]  
**Date:** [YYYY-MM-DD]  
**Status:** [Planning | In Progress | Complete | Killed]

---

## Summary

[1-3 paragraphs: What are we building and why?]

---

## Design Principles

[List 3-5 principles that drive this design. Examples:]

1. Explicit over implicit
2. Subtract first
3. Gradual migration
4. Stable APIs

---

## Planning-Phase Metrics

| Metric | Target | This Plan | Status |
|--------|--------|-----------|--------|
| API surface | ≤50 symbols (≤20 for libs) | [Number] | [PASS/FAIL] |
| Dependencies | ≤5 runtime | [Number] | [PASS/FAIL] |
| Modules | ≤10 files | [Number] | [PASS/FAIL] |
| External interfaces | ≤3 systems | [Number] | [PASS/FAIL] |
| Finished criteria | ≤5 bullets | [Number] | [PASS/FAIL] |

**If any FAIL → Rescope or kill before writing code**

---

## Timeline

**Total duration:** [X weeks/months of dedicated work, one person]

**Assumptions:**
- One person, fully dedicated (no context switching)
- If not fully dedicated: multiply by context-switching factor (2-4x typical)

**Team size multipliers (coordination cost):**
- 1 person: 1x (baseline)
- 2 people: 2x (coordination kills efficiency)
- 3 people: 2.5x
- 4 people: 2x (might get back to 1x if operating as 2 independent teams)
- 5+ people: ∞ (will never get done)

**If you need >1 person, your component is too large. Rescope.**

| Phase | Duration (1 person) | Deliverables |
|-------|---------------------|--------------|
| Phase 0 | [X weeks] | [Foundation/setup] |
| Phase 1 | [X weeks] | [Core implementation] |
| Phase 2 | [X weeks] | [Feature complete] |
| Phase N | [X weeks] | [Done] |

**Total:** [X weeks, one person, fully dedicated]

---

## Phases

### Phase 0: [Name] (Optional - Foundation)

**Duration:** [X weeks]

**Goal:** [What does this phase accomplish?]

**Deliverables:**
- [ ] [Deliverable 1]
- [ ] [Deliverable 2]

**Success criteria:** [How do we know this phase is done?]

### Phase 1: [Name]

**Duration:** [X weeks]

**Goal:** [What does this phase accomplish?]

**Deliverables:**
- [ ] [Deliverable 1]
- [ ] [Deliverable 2]

**Success criteria:** [How do we know this phase is done?]

**Review checkpoint:** [What would make us kill/rescope at this point?]

### Phase 2: [Name]

[Repeat structure]

---

## Review Checkpoints

**After each phase, review progress:**

**Questions:**
- Is this still the right approach?
- Are we making real progress (working code)?
- Sunk cost test: "If we hadn't started, would we start today?"
- Should we kill, rescope, or continue?

**Triggers for kill/rescope:**
- No working code after reasonable effort
- Better alternative discovered
- Requirements changed fundamentally
- Sunk cost test fails

---

## API Design (If Applicable)

### Core Structures

```c
// Example
typedef struct FooParams {
    const char *name;
    int value;
} FooParams;
```

### Public Functions

```c
// Create
Foo *fooCreate(const FooParams *params);

// Use
int fooDoSomething(Foo *foo);

// Destroy
void fooDestroy(Foo *foo);
```

**API surface:** [X symbols]

---

## What We're Deleting

**From existing code:**
- [Feature/function 1] - [Why: unused, broken, etc.]
- [Feature/function 2] - [Why]

**Not adding:**
- [Feature 1] - [Why: out of scope, not needed]
- [Feature 2] - [Why]

---

## Dependencies

**Runtime dependencies (≤5):**
1. [Dependency 1] - [Why needed]
2. [Dependency 2] - [Why needed]

**Build dependencies:**
1. [Dependency 1]
2. [Dependency 2]

**Removing:**
- [Dependency 1] - [Why no longer needed]

---

## Testing Strategy

### Unit Tests
- [What will be tested]

### Integration Tests
- [What will be tested]

### Performance Tests
- [Metric 1]: [Target]
- [Metric 2]: [Target]

### Error Path Tests
- [Scenario 1]
- [Scenario 2]

---

## Kill Criteria

**Abandon this plan if:**
- [ ] [Criterion 1: e.g., Performance regression >10%]
- [ ] [Criterion 2: e.g., Can't finish in 3 months]
- [ ] [Criterion 3: e.g., Sunk cost test fails]

**Sunk cost test (at each phase):** "If we hadn't started, would we start today?"

---

## Early Validation

**How will we validate this idea before heavy investment?**

- [ ] Virtual focus group (see `skills/virtual-focus-group.md`)
- [ ] Prototype (minimal version to test core idea)
- [ ] Competitive analysis (does existing solution win?)
- [ ] Data collection (measure key metrics)

**Questions:**
- Does this solve a real problem?
- Is solution better than alternatives?
- Can we prove with data?

**Do this early (first phase), not after months of work.**

---

## References

- [Related plan 1]
- [Related documentation]
- [External resources]

