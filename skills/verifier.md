---
type: agent_requested
name: Verifier
description: Post-developer cleanup and check phase that interprets deterministic lint/test results, performs subtract-first cleanup (low-value tests and comments), and surfaces recommendations before reviewer gate
when_to_use: after developer's implementation and deterministic format/lint/test checks, before reviewer
version: 1.0.0
prerequisites:
  - developer
next_skills:
  - reviewer
---

# Verifier

**Deterministic first:** Consume the artifacts produced by the developer phase (tests, lint, artifacts), interpret them, then perform low-risk, subtract-first cleanup.

**External side effects:** Code edits only (tests, comments, dead code removal). No commits until reviewer approves.

## Starting a Session

Read all deterministic artifacts from the developer phase:

1. **`.agent/tests-summary.json`** — Test status (PASS/FAIL)
2. **`.agent/tests.log`** — Full test output (if tests failed)
3. **`.agent/lint.log`** — Full lint output
4. **`.agent/notes/architect.md`** — Scope and AC for context
5. **`.agent/tickets.md`** — Tickets being implemented
6. **Git status/diff** — Which files changed (via existing context tools)

## Behavioral Constraints

**Do NOT:**
- Re-run `just lint` or `just test`; rely entirely on the deterministic artifacts produced by developer

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

Present three sections in your response:

### 1. Lint and test status

```
## Lint and test status

Tests: PASS (from .agent/tests-summary.json)
Lint: PASS (from .agent/lint.log)
```

Or if failures:
```
## Lint and test status

Tests: FAIL
Lint: PASS
Relevant output: [snippet from .agent/tests.log]
```

### 2. Changes made

```
## Changes made

- **Removed test case `shouldHandleEmpty()`**: This test only checked the happy path. Regression protection is covered by `shouldHandleEmptyString()` which tests the same code path with different input.
- **Removed comment `// Initialize counter`**: Narration comment, the code is self-explanatory.
- **Deleted dead function `oldParseFormat()`**: Function is not called anywhere in the codebase (grep confirmed).
```

Each deletion: short "why this is safe" explanation.

### 3. Recommendations for Developer/Architect

```
## Recommendations for Developer/Architect

- **Suggested ticket: Extract auth logic into separate module** — Current auth code is duplicated in two handlers; could be refactored into a shared utility for maintainability.
- **Consider: Add integration test for error path** — Current tests focus on happy path; error handling is not well covered and might benefit from an integration test.
```

Format: ticket title + 1–2 sentence justification.

## Session Complete

After presenting the three sections above, wait for human approval.

The reviewer phase will follow, where the human will validate the overall work and make a final decision to approve or reject back to architect.
