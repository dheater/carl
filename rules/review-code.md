# Code Review

**Trigger:** "review code" or "carl review"

**Modes:**
- **Interactive** (user says "review code"): Review → wait for approval → make changes
- **Analysis** (called by "review project"): Review → report findings → NO changes

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

### 3. Comment Quality

**Delete (narration - WHAT not WHY):**
- Repeats function name: `// Increment counter` above `counter++`
- States what next line does: `// Update cache` above `updateCache()`
- Just describes call: `// Create window` above `XCreateWindow()`

**Keep (explains WHY or context):**
- `// Create window (340x120 to match Qt version)` - explains WHY
- `// Use deque for O(1) insertion` - non-obvious decision
- `// Must hold mutex_` - constraint
- `// Boost.Asio bug #12345` - workaround
- Public API docs, bug references, business rules

**Always acceptable:**
- `} // namespace`, `#endif // HEADER_H` - conventional markers

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

## Principles

1. Delete first, question everything, simplify ruthlessly
2. Be specific (line numbers, exact code)
3. Don't hedge ("Delete this" not "Consider deleting")
4. Check usage before suggesting deletion
5. **Respect mode:** Interactive = wait for approval. Analysis = report only, no changes.

## After Review

**Interactive mode:** End with "Wait for your input before making changes." Don't make changes, hedge, praise, or apologize.

**Analysis mode:** Report findings with file/line refs, categorize by P0/P1/P2. Don't make changes, ask approval, or wait.

