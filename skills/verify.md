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
2. Choose the smallest meaningful validation. Prefer targeted unit tests, package tests, type-checks, or small smoke checks.
3. Run commands directly. Do not claim results you did not run.
4. If validation is missing or impossible, say so directly and explain the risk.

## Report

- `## Validation plan`
- `## Commands run` — include exit code for each command
- `## Results`
- `## Acceptance criteria` — `[met]`, `[gap]`, or `[unknown]`
- `## Remaining risk`

No code changes. No commit message. No narration.