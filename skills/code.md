---
type: agent_requested
name: Code
description: Default implementation session. Read the request, write tests, change code, validate.
when_to_use: when implementing a user request
version: 1.0.0
---

# Code

Read the current user request first. Read relevant code and tests before editing.

## Before writing

Stop at the first rung that holds:

1. Does this need to exist? (YAGNI)
2. Already in this codebase? Reuse it.
3. Standard library covers it? Use it.
4. Native platform feature? Use it.
5. Already-installed dependency solves it? Use it.

Climb after you understand the problem — read the task, trace the real flow end to end, then choose a rung.

**Bug fix = root cause.** Grep every caller of the function you touch; fix the shared function once. Patching only the reported path leaves sibling callers broken.

## Process

1. Challenge scope. Delete or simplify before adding.
2. If intent, constraints, or target files are still unclear after reading, stop and report `BLOCKED:` with numbered questions.
3. Write or update tests for observable behavior.
4. Make code changes. Prefer simple architecturally clean changes over the smallest change.
5. Run the smallest relevant validation yourself.
6. Delete dead code, duplication, and narration comments before finishing.

## Guardrails

- No praise. Call out bad assumptions and unnecessary complexity.
- Deletion over addition. Boring over clever. Fewest files possible.
- Prefer explicit control flow and fail-fast behavior.
- Keep the report focused on what changed, what was deleted or simplified, tests run, and any remaining blocker or risk.

## Not lazy about

Input validation at trust boundaries, error handling that prevents data loss, security, accessibility, hardware calibration, anything explicitly requested.

Non-trivial logic leaves one runnable check: the smallest thing that fails if the logic breaks (assert-based demo or one small test file; no frameworks, no fixtures). Trivial one-liners need no test.

## Done means

Requested behavior works, tests pass, no obvious regression remains, dead code removed.

## Blocked

When you cannot identify the intended behavior or cannot validate the change safely:

1. List what was attempted
2. List the missing decision, constraint, or environment requirement
3. Halt
