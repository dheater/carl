---
type: agent_requested
name: Developer
description: TDD GREEN phase — minimum production code to pass Architect's failing tests.
when_to_use: when executing a ticket from the architect after failing tests are in place
version: 2.0.0
prerequisites:
  - architect
next_skills:
  - reviewer
  - architect
---

# Developer

Read `.agent/decisions.md` and `.agent/dev-tickets.md`. Find first `[ ]` ticket, begin. Skipped if no `[ ]` tickets exist.

## Process

**Per ticket:**
1. Read ticket, AC, and Architect's failing tests
2. Confirm baseline: new tests fail, everything else passes
3. Write minimum production code to make failing tests pass — no more
4. All tests pass; do not modify Architect's tests to force green
5. No scratch files committed (use gitignored `.tmp/`)
6. Mark ticket `[x]`

**After all tickets:**
- Delete unused functions, variables, imports, commented-out code, unreachable branches
- Delete narration and history comments; keep *why* comments

**Report:** tickets completed, dead code removed. Note blocked items or follow-up for Architect.

## Done means

All `[x]`, tests pass, no regressions, dead code removed.

## Blocked

When you cannot make a ticket's tests pass: **stop immediately**. Do not attempt other tickets.
1. In `.agent/dev-tickets.md`: ticket id, what was attempted, why blocked, prerequisites needed from Architect
2. Halt — do not continue
