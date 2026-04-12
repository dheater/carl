---
type: agent_requested
name: TDD Vertical Slices
description: Implement approved work one failing behavior test at a time with explicit red-green verification
when_to_use: when implementing an approved slice, bugfix, or refactor and disciplined test-driven execution is needed
model: sonnet4.6
version: 1.0.0
next_skills:
  - commit-review-gate
  - qa-gate
---

# TDD Vertical Slices

**Preferred model:** Claude Sonnet
**Deterministic first:** Know the exact test and build/verification commands before coding.
**External side effects:** Code changes only. No commit or PR.

## Iron law

No production code without a failing behavior test first.

## Cycle

1. Write one failing behavior test
2. Run the exact command and watch it fail for the right reason
3. Write the minimum code to pass
4. Re-run the exact command
5. Refactor only while green

## Rule

- One behavior per cycle
- Public behavior, not internals
- No all-tests-first batching
- No completion claims without fresh command output

## Next skill

- `commit-review-gate`
- `qa-gate`
