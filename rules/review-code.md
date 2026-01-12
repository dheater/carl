# Code Review

**Enforcement:** Guideline for AI and human review (not automated)

**Trigger:** User says "review code" or "carl review"

**Purpose:** Comprehensive code review following Carl's principles: delete over add, simplify over complicate, explicit over implicit.

## Review Checklist

### 1. Dead Code

**Look for:**
- Unused imports, functions, types, variables
- Commented-out code
- Unreachable code
- Tests that don't test anything (just `return true`)
- Stale comments referencing deleted features
- Exported functions/types that are never used

**Action:** Delete. No exceptions.

### 2. Duplication

**Look for:**
- Identical or near-identical code blocks
- Copy-pasted logic that should be extracted
- Repeated patterns that could be abstracted
- Similar error messages that could be unified
- Functions that differ only in one parameter

**Action:** Extract to helper, unify, or delete one copy.

### 3. Unnecessary Comments

**Delete if:**
- Repeats type/function name ("C++ standard versions" above `CppStd`)
- Narrates code ("Increment counter" above `counter++`)
- States what next line does without explaining WHY
- Section headers that are obvious from code structure
- "Build combined flags" above flag-building code

**Keep if:**
- Explains WHY (non-obvious decisions, constraints, workarounds)
- Documents public API (parameters, return, errors, thread safety)
- Shows examples of non-obvious usage
- References bugs, issues, or external requirements
- Explains business rules or domain constraints

### 4. Simplification Opportunities

**Ask:**
- Can we delete this entirely?
- Can we merge similar functions?
- Can we use simpler types?
- Can we remove parameters/options?
- Can we make invalid states unrepresentable?
- Can we use the type system instead of runtime checks?
- Are there wrapper functions that add no value?
- Are there options/parameters that are never used?

### 5. API Design

**Look for:**
- Too many ways to do the same thing
- Unclear or inconsistent function names
- Confusing pairs (e.g., `addX` vs `linkX`)
- Missing better defaults
- Complex functions with many options (split them)
- Singular/plural variants both needed?
- Wrappers that add no value

### 6. Critical Issues

**Look for:**
- Unused parameters (`_ = x;`)
- Error handling that silently fails
- Missing error propagation
- Potential panics that could be errors
- Type safety violations
- Memory leaks or missing cleanup

## Type System vs Runtime Checks

**Critical question for every error case:**
"Can we avoid this error through API design and use of the type system?"

### Examples of Type System Solutions

**Runtime check → Type system:**
- String validation → Enum types
- Mixing C/C++ standards → Separate `CStd` and `CppStd` types
- Invalid state combinations → Make invalid states unrepresentable
- Null checks → Use optional types explicitly
- Range validation → Use bounded types or enums

### When reviewing error handling:

**Keep runtime errors only for:**
- I/O failures (file not found, network errors)
- Resource exhaustion (OOM, disk full)
- External command failures (pkg-config not installed)
- User input validation (config files, command line)

**Delete runtime errors for:**
- Type mismatches (use type system)
- Invalid combinations (use distinct types)
- Missing required fields (use non-optional types)

### Review Pattern

For each error message/panic/validation:
```
❌ Runtime: if (is_cpp_flag && is_c_source) panic("Can't use C++ flags with C")
✅ Type system: addCSources(sources, CStd) vs addCppSources(sources, CppStd)

❌ Runtime: if (!valid_standard(std)) panic("Invalid standard")
✅ Type system: enum CStd { c89, c99, c11, c17, c23 }

❌ Runtime: if (state == null && trying_to_use) panic("Not initialized")
✅ Type system: Separate Init and Ready types, can't call methods on Init
```

## Output Format

```markdown
## Code Review - Dead Code, Duplication, and Simplification

### Dead Code
1. **Line X-Y: Description** - Why it's dead. Delete it.

### Duplication
1. **Lines X-Y and A-B: Description** - What's duplicated. Extract to helper.

### Unnecessary Comments
1. **Line X: Comment text** - Why unnecessary. Delete.

### Simplification Suggestions
1. **Feature/Function name** - Current complexity. Simpler alternative.

### Critical Issues
1. **Line X: Issue** - What's wrong. How to fix.

### Summary of Deletions
- Item 1
- Item 2

### Summary of Simplifications
1. Suggestion 1
2. Suggestion 2

**Total savings: ~N lines of dead/duplicate code**
```

## Review Principles

1. **Delete first** - Always look for what can be removed before suggesting additions
2. **Question everything** - Why does this exist? Is it solving a real problem?
3. **Simplify ruthlessly** - Complexity is the enemy
4. **Be specific** - Line numbers, exact code, concrete suggestions
5. **Don't hedge** - "Delete this" not "Consider deleting this"
6. **Check usage** - grep for actual usage before suggesting deletion
7. **Wait for approval** - Review only, don't make changes without user confirmation

## Investigation Steps

1. **View the entire file** to understand structure
2. **Search for usage** of suspicious functions/types across codebase
3. **Check tests** to see what's actually tested
4. **Check docs** to see what's documented vs used
5. **Ask clarifying questions** if purpose is unclear

## After Review

**Always end with:**
"Wait for your input before making changes."

**Don't:**
- Make changes during review
- Hedge suggestions ("maybe", "consider", "perhaps")
- Praise existing code
- Apologize for being direct
- Suggest additions unless deleting something requires replacement

