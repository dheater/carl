# Writing Carl Rules

**Enforcement:** Guideline for rule authors (not enforced on projects)

**Purpose:** How to write effective Carl rules. This rule is dogfooded - it follows its own guidelines.

---

## Structure

Every Carl rule follows this structure:

```markdown
# Rule Name

## Principle
[Core idea in 1-4 sentences. What is the rule?]

## Why
[Rationale. Why does this matter? What problems does it solve?]

## Examples
[Concrete before/after or good/bad examples]

## Enforcement
[How is this checked? Automated tool? Code review? Not enforceable?]

## References
[Optional: Links to related rules, external sources]
```

---

## Tone

**Prescriptive, not suggestive:**
- ✅ "Do X" not "Consider doing X"
- ✅ "Never Y" not "It's generally better to avoid Y"
- ✅ "Delete Z" not "You might want to think about removing Z"

**Token-efficient:**
- Delete unnecessary words
- Use tables, checklists, decision trees
- Avoid repetition
- No fluff or filler

**Direct:**
- State the rule clearly
- Don't apologize for being opinionated
- Challenge bad practices explicitly

---

## Length

**Target: 50-150 lines per rule**

**Guiding principles, not exhaustive:**
- Cover the core concept
- Provide enough examples to understand
- Link to tools for details
- Don't repeat what tools will check

**If a rule exceeds 150 lines:**
- Split into multiple rules
- Move examples to examples/
- Move enforcement details to tool documentation

---

## Format Patterns

### Checklists (for pre-action verification)

```markdown
## Before Changing Public API
- [ ] Is this add-only?
- [ ] Are defaults unchanged?
- [ ] Incompatible? Bump major version (rare, clean break)
- [ ] Run: `carl check_abi`
```

### Decision Trees (for choosing between options)

```markdown
## Adding a Dependency

Can you duplicate it? (≤200 LOC)
  YES → Duplicate
  NO  → Can you vendor it?
    YES → Vendor
    NO  → Is it essential?
      YES → Add (justify)
      NO  → Redesign
```

### Tables (for anti-patterns)

```markdown
| ❌ DON'T | ✅ DO | Why |
|----------|-------|-----|
| `error: Invalid` | `error: Cannot use []Type. Use: x: []T = [a];` | Teach |
```

### Prose (for philosophy)

Keep minimal. Use bullet points where possible.

---

## When to Create a New Rule

**Create a new rule when:**
- ✅ It's a distinct principle (not a sub-point of existing rule)
- ✅ It has enforceable aspects (tool can check it)
- ✅ It applies broadly (not project-specific)
- ✅ It's actionable (developers can apply it)

**Don't create a new rule when:**
- ❌ It's a detail of an existing rule (extend instead)
- ❌ It's too subjective (no clear right/wrong)
- ❌ It's project-specific (belongs in project docs)
- ❌ It's a one-time decision (not a recurring pattern)

---

## Identifying Enforceable Aspects

**Ask:**
1. Can a tool detect violations? (static analysis, parsing, counting)
2. Can a tool suggest fixes? (helpful error messages)
3. Is the rule objective? (clear pass/fail criteria)

**If yes to all three:** Write a tool. Document in "Enforcement" section.

**If no:** Mark as "Not automatable. Apply during code review."

---

## Writing Helpful Tool Violations

When a tool detects a violation, output should teach:

```json
{
  "tool": "check-X",
  "status": "warn",
  "message": "What went wrong (specific)",
  "rationale": "Why this matters",
  "suggestion": "How to fix it (actionable)",
  "details": { ... },
  "references": ["~/.carl/rules/X.md"]
}
```

**Include in the rule:**
- What the tool checks
- What violations look like
- How to fix common violations

---

## Testing Rules

**Before committing a rule:**

1. **Apply to real code** - Does it work in practice?
2. **Check token count** - Is it concise?
3. **Read aloud** - Is it clear?
4. **Challenge it** - Can you delete half of it?

**Iterate:**
- Remove unnecessary examples
- Simplify language
- Merge redundant sections
- Delete obvious statements

---

## Examples

**Bad rule (too vague):**
> "Try to keep dependencies minimal. Consider whether you really need each one."

**Good rule (specific, actionable):**
> "Limit runtime dependencies to ≤5. Prefer: duplicate (≤200 LOC) → vendor → static → dynamic."

---

**Bad rule (too long, exhaustive):**
> [500 lines covering every possible dependency scenario]

**Good rule (principle + tool):**
> [50 lines covering principle, examples, enforcement via `carl check-deps`]

---

## Anti-Patterns

**❌ Don't:**
- Write rules that can't be applied
- Create rules for one-time decisions
- Repeat what existing rules say
- Write rules that are too subjective
- Make rules project-specific

**✅ Do:**
- Write actionable, enforceable rules
- Keep rules focused and concise
- Provide concrete examples
- Link to tools for enforcement
- Make rules broadly applicable

---

## This Rule is Dogfooded

This rule follows its own structure:
- ✅ Principle: How to write Carl rules
- ✅ Why: Consistency, token-efficiency, enforceability
- ✅ Examples: Good/bad rule examples
- ✅ Enforcement: Self-review checklist
- ✅ Length: ~150 lines
- ✅ Format: Mix of prose, checklists, tables

