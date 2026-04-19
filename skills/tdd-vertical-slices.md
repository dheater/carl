---
type: agent_requested
name: TDD Vertical Slices
description: Implement approved work one failing behavior test at a time with explicit red-green verification
when_to_use: when implementing an approved slice, bugfix, or refactor and disciplined test-driven execution is needed
model: sonnet4.6
version: 1.0.0
---

# TDD Vertical Slices

**Deterministic first:** Know the exact test and build commands before coding.
**External side effects:** Code changes only. No commit or PR.

## Iron Law

No production code without a failing behavior test first.

## Cycle

1. Write one failing behavior test
2. Run exact command — watch it fail for the right reason
3. Write minimum code to pass
4. Re-run — confirm green
5. Refactor only while green

## Rules

- One behavior per cycle; public behavior, not internals
- No all-tests-first batching
- No completion claims without fresh command output
