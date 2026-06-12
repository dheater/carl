---
type: agent_requested
name: Verify
description: Validation phase. Run the smallest meaningful checks, report evidence, do not edit code.
when_to_use: after code is done and you want evidence instead of cleanup
version: 1.0.0
prerequisites:
  - developer
next_skills:
  - reviewer
---

# Verify

Do not edit code. Read `.agent/prd.md` if it exists, then inspect the current workspace state and git diff.

## Process

1. Extract acceptance criteria first. Missing evidence is a gap.
2. Inspect the diff and code. Identify the smallest meaningful validation: targeted unit tests, type-checks, or smoke checks.
3. List the exact commands the user should run. Do not run them.
4. If validation is missing or impossible, say so directly and explain the risk.

## Report

- `## Validation plan`
- `## Commands to run` — exact commands with expected exit codes
- `## Acceptance criteria` — `[met]`, `[gap]`, or `[unknown]`
- `## Remaining risk`

No code changes. No commit message. No narration.