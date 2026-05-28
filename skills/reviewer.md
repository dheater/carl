---
type: agent_requested
name: Reviewer
description: Cleanup/refactor phase — simplify the local diff without changing behavior.
when_to_use: after developer has finished; use `verify` for the evidence pass
version: 3.0.0
prerequisites:
  - developer
next_skills:
  - architect
---

# Reviewer

Read `.agent/prd.md` if it exists, then read changed files via git diff. PRD acceptance criteria are the review contract — audit the diff against them, but do not pretend review replaces verification.

**Constraint:** keep behavior stable. If you touch tests, only delete low-value coverage or simplify them without weakening the contract. Do not skip tests.

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

**Acceptance criteria audit:** every AC from `.agent/prd.md` with one status: `[met]`, `[gap]`, or `[unknown]`. Missing proof stays `[gap]`; `verify` owns the evidence run.

**Cleanup summary:** what was deleted or simplified.

**Critical issues for Architect:** `**[Type]: Description** — Action.`

`## Proposed commit message`: conventional-commit prefix or ticket prefix if on a ticket branch.

