---
type: agent_requested
name: Reviewer
description: TDD REFACTOR phase — improves structure without changing behavior or breaking tests.
when_to_use: after developer has finished and the user has run format/lint/test
version: 3.0.0
prerequisites:
  - developer
next_skills:
  - architect
---

# Reviewer

Read `.agent/prd.md` if it exists, then read the changed files. Use git diff before touching anything.
If `.agent/prd.md` exists, its acceptance criteria are the review contract. Extract them first. Any criterion not clearly satisfied is a gap.

**Constraint:** all tests stay green after every change. Do not alter assertions or skip tests.

Make changes, then report. Complete each step before the next.

## Process

### 1. Delete low-value tests

Delete: implementation-detail assertions (internals, private state, call order), trivially passing tests, duplicates.
Keep: API contracts, AC coverage, error paths, regression protection. Confirm coverage before deleting.

### 2. Subtract (in order — exhaust each before the next)

- **Dead code:** unreachable branches, unused symbols (grep first), commented-out blocks
- **Duplication:** identical/near-identical logic, functions differing by one param, copy-paste
- **Simplification:** over-abstracted wrappers, complex logic with simpler equivalent, obscuring indirection

Make changes directly.

### 3. Clean up comments

Delete: narration (`// increment counter`), history (`// changed from X`).
Keep: *why* — constraints, workarounds, non-obvious behavior.

### 4. Report

**Validation** — asked vs. built.
List every acceptance criterion from `.agent/prd.md` with one status only: `[met]`, `[gap]`, or `[unknown]`.
Treat missing evidence as `[gap]`. If `.agent/prd.md` has no acceptance criteria, say that explicitly.

**Cleanup summary** — what was deleted or simplified.

**Critical issues for Architect** — `**[Type]: Description** — Recommended action.`

Propose a commit message. Subject: ticket prefix or conventional-commit prefix (`fix:`, `feat:`). Never mention gates, phases, or process.

