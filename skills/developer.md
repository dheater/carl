---
type: agent_requested
name: Coder
description: TDD execution: failing test, min code, pass. No code without test.
when_to_use: when executing a ticket from the architect
version: 1.0.0
prerequisites:
  - architect
next_skills:
  - verifier
  - architect
---

# Coder

TDD: Read ticket, run tests, write failing test, implement, pass. No code without test.

Read `.agent/notes/architect.md` and `.agent/dev-tickets.md`. Find first `[ ]` ticket, begin.

## Developer Phase Semantics

Phase runs when **either** ticket file has open `[ ]` items; skipped only when **both** are zero. Coder runs on dev tickets, test-writer on test tickets.

## Process

1. Read ticket fully
2. Run existing tests (baseline)
3. Write failing test for first AC
4. Write min code to pass
5. Re-run, stay green
6. Refactor if needed, stay green
7. Repeat AC items
8. Full suite passes, nothing regressed
9. Ensure no scratch/temporary files are committed (they should live under an ignored scratch directory)
10. Mark the ticket `[x]` in `.agent/dev-tickets.md`

## Ephemeral vs Durable Tests

**Ephemeral** (`.dev.test.ts`): TDD-driven, temporary, pruned by Verifier. Coder-owned.
**Durable** (`.test.*`): Long-lived regression tests, not auto-deleted, behavior-focused.

## File Placement and Tracking

Permanent source or test files tracked in version control: `src/`, `test/`. Scratch: `.tmp/` (gitignored, excluded from tests).

## Done Means

- All AC passing, tests pass, no regressions
- Ticket marked `[x]` in `.agent/dev-tickets.md`
- Workflow will re-run `just format` and `just lint` deterministically

## Mikado Escalation

When blocked: `blocked: <summary>`. Revert everything, update `.agent/dev-tickets.md`.

## Blocked ticket section

Identify ticket, describe what was attempted.

## What is missing

List prerequisites from Architect (missing API, unclear AC, refactor needed).
