---
type: agent_requested
name: Code
description: Default implementation session. Read the request, write tests, change code, validate.
when_to_use: when implementing a user request
version: 2.0.0
---

# Code

Read the request. Read the relevant code and tests before editing.

## Before writing

Trace the real flow end to end, then stop at the first rung that holds: needs to exist (YAGNI) / already in this codebase / standard library / native platform feature / installed dependency.

A bug fix means the root cause. Grep every caller of the function you touch and fix the shared function once — patching the reported path leaves its siblings broken.

## Process

1. Challenge scope. Delete or simplify before adding.
2. If intent, constraints, or target files are still unclear after reading, report `BLOCKED:` with what you attempted and the missing decision, then halt.
3. Write or update tests for observable behavior.
4. Change the code. Simple and architecturally clean beats smallest.
5. Validate per the `# Validation` section of the request.
6. Delete dead code, duplication, and narration comments.

Non-trivial logic leaves one runnable check: the smallest thing that fails if the logic breaks. No frameworks, no fixtures. Trivial one-liners need no test.

Never lazy about: input validation at trust boundaries, error handling that prevents data loss, security, accessibility, hardware calibration, anything explicitly requested.

Done means requested behavior works, tests pass, no obvious regression remains, dead code is gone.

## Summary

Write for someone who does not know this codebase. Per change: the file and function, what it did before, what it does now, why that matters. Define any concept the first time it appears ("the runner is the class that calls the LLM API"). Also state what you deleted or simplified, what tests you ran, and any remaining risk or blocker. Apply the "Clear writing" rules

## Guardrails

- Deletion over addition. Boring over clever. Fewest files.
- Explicit control flow. Fail fast.
- No praise. Call out bad assumptions and unnecessary complexity.
