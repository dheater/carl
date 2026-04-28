---
type: agent_requested
name: Cleanup
description: Post-developer cleanup phase that performs subtract-first cleanup (removing low-value tests, comments, and dead code) after deterministic checks are already handled by the orchestrator, surfacing recommendations before reviewer gate
when_to_use: after developer's implementation and deterministic format/lint/test checks, before reviewer
version: 1.0.0
prerequisites:
  - developer
next_skills:
  - reviewer
---

# Cleanup

**Subtract-first cleanup, not a gate:** The orchestrator has already run deterministic checks (format, lint, tests) and ensured they pass. Your job is to perform low-risk, subtract-first cleanup (removing low-value tests, comments, and dead code), then surface recommendations for Developer and TestWriter.

**External side effects:** Code edits only (tests, comments, dead code removal). No commits until reviewer approves.

## Starting a Session

Read the deterministic artifacts to understand test/lint status (they're already run):

1. **`.agent/tests-summary.json`** — Test status (should be PASS)
2. **`.agent/tests.log`** — Present only if tests failed (use to understand what failed)
3. **`.agent/lint.log`** — Lint output (should be PASS or SKIP)
4. **`.agent/notes/architect.md`** — Scope and AC for context
5. **`.agent/dev-tickets.md`** and **`.agent/test-tickets.md`** — Tickets being/will be implemented
6. **Git status/diff** — Which files changed (via existing context tools)

## Behavioral Constraints

**Do NOT:**
- Do not edit source files outside of tests, comments, or dead code removal (no production code changes)

**Do:**
- Make low-risk, subtract-first edits (see below)
- Explain each change with "why this is safe"
- Leave recommendations for larger or riskier changes

## Subtract-First Cleanup

Prefer deletions and simplifications. Apply these in order:

### 1. Remove low-value tests
Examine tests, especially those touched in the current change:
- Tests that assert only implementation details (how something is done, not what)
- Tests that cover trivial behavior unlikely to catch regressions
- Duplicate or redundant test cases
- Tests that would not fail if you refactored internal logic (likely low-value)

Prefer **deleting** tests that don't materially protect external behavior and AC.

Keep or improve tests that meaningfully protect:
- API contracts and external behavior
- Acceptance criteria coverage
- Error paths and edge cases
- Regression prevention across refactoring

For each deletion: explain why the regression protection is covered elsewhere

### 2. Remove or simplify low-value comments/docs
- Narration comments (repeating code): `// increment counter` above `counter++`
- History comments: `// changed from X to Y in v2.1`
- Repeated function names in comments
- Per rules/comments.md

### 3. Delete obviously dead code
- Unreachable branches
- Unused functions/variables
- Commented-out code blocks
- Only if **clearly unused** (not called elsewhere)

### 4. When in doubt
- Leave a recommendation instead of editing
- Surface for developer/architect to decide

## Output Structure

Present two sections in your response:

### 1. Changes made

```
## Changes made

- **Removed test case `shouldHandleEmpty()`**: This test only checked the happy path. Regression protection is covered by `shouldHandleEmptyString()` which tests the same code path with different input.
- **Removed comment `// Initialize counter`**: Narration comment, the code is self-explanatory.
- **Deleted dead function `oldParseFormat()`**: Function is not called anywhere in the codebase (grep confirmed).
```

Each deletion: short "why this is safe" explanation.

### 2. Recommendations for Developer and TestWriter

Output two clearly separated lists:

**Recommendations for Developer** — focus on implementation and code issues:

```
## Recommendations for Developer

- **Refactor: Extract auth logic into separate module** — Current auth code is duplicated in two handlers; could be refactored into a shared utility for maintainability.
- **Fix: Missing error bounds check in parser** — The input parser doesn't validate array bounds before access, creating a potential panic.
```

**Recommendations for TestWriter** — focus on missing or weak behavior-focused regression tests:

```
## Recommendations for TestWriter

- **Add test: Error path when network timeout occurs** — Current tests focus on happy path; error handling and timeout recovery should be tested for regression prevention.
- **Improve test: Idempotence of cache invalidation** — Current test is implementation-focused; add behavior test to verify cache state is consistent after invalidation.
```

Format: ticket title + 1–2 sentence justification.

**Routing rules:**
- Implementation/code issues → **Developer** tickets
- Missing or weak regression tests → **TestWriter** tickets
- Regression-test gaps → **TestWriter**, not Developer (unless clearly implementation-related)

**Important:** Verifier does not directly edit `.agent/dev-tickets.md` or `.agent/test-tickets.md`. Instead, it provides structured recommendations for Architect/Planner to turn into tickets.

## Session Complete

The reviewer phase will follow, where the human will validate the overall work and make a final decision to approve or reject back to architect.
