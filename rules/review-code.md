# Code Review

**Trigger:** "review code" or "carl review"

**Modes:**
- **Interactive:** Review → wait for approval → make changes
- **Analysis:** Review → report findings → NO changes

## Review Checklist

### 1. Dead Code
Unused imports/functions/types/variables, commented-out code, unreachable code, tests that test nothing, stale comments, unused exports. **Delete. No exceptions.**

### 2. Duplication
Identical/near-identical blocks, copy-pasted logic, repeated patterns, similar error messages, functions differing by one parameter. **Extract, unify, or delete.**

### 3. Comment Quality
**Delete (narration):** Repeats function name, states what next line does.

**Keep (explains WHY):** Non-obvious decisions, constraints (`// Must hold mutex_`), workarounds (`// Boost.Asio bug #12345`), public API docs.

### 4. Simplification Opportunities
- Delete entirely? Merge similar functions? Simpler types? Fewer parameters?
- Make invalid states unrepresentable? Type system instead of runtime checks?
- Wrapper functions with no value? Unused options/parameters?

### 5. API Design
Too many ways to do the same thing? Inconsistent names? Missing better defaults? Complex functions with many options? Wrappers adding no value?

### 6. Critical Issues
Unused parameters, silent error failures, missing error propagation, potential panics, type safety violations, memory leaks.

## Type System vs Runtime Checks

**Ask first:** Can this error be prevented through API design?

| ❌ Runtime | ✅ Type system |
|-----------|----------------|
| `if (is_cpp && is_c) panic(...)` | `addCSources(CStd)` vs `addCppSources(CppStd)` |
| `if (!valid_std(s)) panic(...)` | `enum CStd { c89, c99, c11, c17, c23 }` |
| `if (state == null) panic(...)` | Separate Init and Ready types |

**Keep runtime errors only for:** I/O failures, resource exhaustion, external command failures, user input validation.

## Output Format

```markdown
## Code Review

### Dead Code
1. **Line X-Y: Description** - Delete.

### Duplication
1. **Lines X-Y and A-B** - Extract to helper.

### Unnecessary Comments
1. **Line X: Comment** - Delete.

### Simplification
1. **Function/Feature** - Simpler alternative.

### Critical Issues
1. **Line X: Issue** - How to fix.

**Total savings: ~N lines**
```

## Principles

Delete first. Be specific (line numbers). Don't hedge. Check usage before suggesting deletion. Respect mode.

## After Review

**Interactive:** End with "Wait for your input before making changes."

**Analysis:** Report with file/line refs, P0/P1/P2. No changes.

