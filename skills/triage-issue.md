---
type: agent_requested
name: Triage Issue
description: Investigate a bug to root cause and produce a fix plan before implementation
when_to_use: when a bug, regression, or unexpected behavior is reported and root cause plus a fix plan are needed before coding
version: 1.0.0
next_skills:
  - tdd-vertical-slices
---

# Triage Issue

**Preferred model:** Claude Opus
**Deterministic first:** Reproduce or inspect the failure, read the code path, inspect tests, run the failing commands when possible.
**External side effects:** None by default

## Rule

Investigate first. Fix second.

Separate:
- Symptom
- Code path
- Root cause
- Missing verification

## Output

Produce:
1. One-sentence root cause
2. Durable findings if the user wants them
3. A thin TDD fix plan

## Next skill

- `tdd-vertical-slices`
