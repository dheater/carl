---
type: agent_requested
name: QA Gate
description: Run deterministic verification, assemble evidence, and pause for approval before declaring work complete
when_to_use: when implementation appears done and explicit verification plus human review are needed before completion
version: 1.0.0
prerequisites:
  - grey
  - tdd-vertical-slices
---

# QA Gate

**Preferred model:** Claude Sonnet
**Deterministic first:** Run the real verification commands and capture pass/fail results.
**External side effects:** None

## Rule

QA is a gate, not a sentence.

Before asking for approval, show:
- Exact commands run
- Pass/fail results
- Skipped checks and why
- Residual risks

## Output

Produce a short QA summary and pause for approval.
