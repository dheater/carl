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

Read changed files via git diff. If `.agent/prd.md` exists, its acceptance criteria are the review contract — audit the diff against them, but do not pretend review replaces verification.

**Constraint:** keep behavior stable. If you touch tests, only delete low-value coverage or simplify them without weakening the contract.

## Process (exhaust each step before the next)

### 1. Delete low-value tests

Delete: implementation-detail assertions (internals, private state, call order), trivially passing tests, duplicates.
Keep: API contracts, AC coverage, error paths, regression protection.

### 2. Subtract

- **Dead code:** unreachable branches, unused symbols, commented-out blocks
- **Duplication:** identical/near-identical logic, one-param variants, copy-paste
- **Simplification:** over-abstracted wrappers, obscuring indirection

### 3. Comments

Delete by default. Keep only _why_ — constraints, workarounds, non-obvious behavior. Delete narration and history.

### 4. Report

If `.agent/prd.md` exists, include **Acceptance criteria audit:** every AC with one status: `[met]`, `[gap]`, or `[unknown]`. Missing proof stays `[gap]`; `verify` owns the evidence run. If no PRD exists, omit this section entirely — do not mention it.

**Cleanup summary:** what was deleted or simplified.

**Suggestions:** prefix each item with "Consider" or "Assess". Write each as a self-contained, actionable statement — specific enough to paste directly into `carl code` as a prompt without any editing.

`## Proposed commit message`: conventional-commit prefix or ticket prefix if on a ticket branch.
