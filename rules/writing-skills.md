# Writing Carl Rules

**Purpose:** How to write effective Carl rules.

## Structure

```markdown
# Rule Name

## Principle
[Core idea in 1-4 sentences]

## Why
[Rationale: problems it solves]

## Examples
[Concrete before/after or good/bad]

## Enforcement
[Automated tool? Code review? Not enforceable?]
```

## Tone

Prescriptive, not suggestive. Token-efficient: tables, checklists, decision trees. No fluff.

- ✅ "Do X" not "Consider doing X"
- ✅ "Never Y" not "It's generally better to avoid Y"

## Length

**Target: 50-150 lines per rule.** If longer: split rules, move examples out, move enforcement to tool docs.

## Format Patterns

**Checklists** — pre-action verification:
```markdown
- [ ] Is this add-only?
- [ ] Defaults unchanged?
```

**Decision Trees** — choosing between options:
```
Can duplicate? (≤200 LOC)
  YES → Duplicate
  NO  → Vendor/Static/Dynamic
```

**Tables** — anti-patterns:
```markdown
| ❌ DON'T | ✅ DO |
|----------|-------|
| `error: Invalid` | `error: Cannot use []Type. Use: x: []T = [a];` |
```

## When to Create a New Rule

**Create when:** Distinct principle, enforceable, broadly applicable, actionable.

**Don't create when:** Detail of existing rule, too subjective, project-specific, one-time decision.

## Enforcement Violations

Tool violations should teach: what went wrong, why it matters, how to fix it, reference to rule.

## Before Committing a Rule

1. Apply to real code — does it work?
2. Check token count — is it concise?
3. Read aloud — is it clear?
4. Challenge it — can you delete half?

**Bad:** "Try to keep dependencies minimal. Consider whether you really need each one."

**Good:** "Limit runtime deps to ≤5. Prefer: duplicate (≤200 LOC) → vendor → static → dynamic."

