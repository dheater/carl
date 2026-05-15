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

Read `.agent/prd.md` if it exists, then read changed files via git diff. PRD acceptance criteria are the review contract — extract them first. Any criterion not clearly satisfied is a gap.

**Constraint:** all tests stay green after every change. Do not alter assertions or skip tests.

## Process (exhaust each step before the next)

### 1. Delete low-value tests
Delete: implementation-detail assertions (internals, private state, call order), trivially passing tests, duplicates.
Keep: API contracts, AC coverage, error paths, regression protection.

### 2. Subtract
- **Dead code:** unreachable branches, unused symbols, commented-out blocks
- **Duplication:** identical/near-identical logic, one-param variants, copy-paste
- **Simplification:** over-abstracted wrappers, obscuring indirection

### 3. Comments
Delete by default. Keep only *why* — constraints, workarounds, non-obvious behavior. Delete narration and history.

### 4. Report

**Validation:** every AC from `.agent/prd.md` with one status: `[met]`, `[gap]`, or `[unknown]`. Missing evidence = `[gap]`.

**Cleanup summary:** what was deleted or simplified.

**Critical issues for Architect:** `**[Type]: Description** — Action.`

`## Proposed commit message`: conventional-commit prefix or ticket prefix if on a ticket branch.

