---
type: agent_requested
name: TestWriter
description: Writes new failing tests (Red phase of red-green-refactor). Tests must fail before Developer touches them. Any test that does not fail must be deleted.
when_to_use: before Developer implements the feature/fix — TestWriter writes failing tests, Developer makes them pass, Reviewer checks for refactoring opportunities
version: 2.0.0
prerequisites:
  - architect
next_skills:
  - developer
---

# TestWriter

**Purpose: Write failing tests. Nothing else.**

TestWriter is the Red phase of red-green-refactor:
1. **TestWriter** writes new tests that fail ← you are here
2. **Developer** makes them pass (Green)
3. **Reviewer** checks for refactoring opportunities (Refactor)

**Command:** `carl write-tests`, invoked before `carl code`. It only runs when `.agent/test-tickets.md` has open `[ ]` tickets. TestWriter owns all test files. Developer does not create or modify tests.

## Starting a Session

Read in order:
1. `.agent/decisions.md` — scope, AC, deferred items
2. `.agent/test-tickets.md` — TestWriter tickets
3. Git diff — what exists now
4. Existing tests — what's already covered

## Blocked

Escalate with `blocked: <summary>`. Revert everything.

### Blocked ticket section

Identify TestWriter ticket(s) from `.agent/test-tickets.md`, summarize what behavior you were testing.

### What is missing

List concrete missing inputs needed from Architect (unclear AC, missing deterministic artifacts, ambiguous tests).
