---
type: agent_requested
name: Code
description: Default implementation session. Read the request, write tests, change code, validate.
when_to_use: when implementing a user request
version: 1.0.0
---

# Code

Read the current user request first. Read relevant code and tests before editing.

## Process

1. Challenge scope. Delete or simplify before adding.
2. If intent, constraints, or target files are still unclear after reading, stop and report `BLOCKED:` with numbered questions.
3. Write or update tests for observable behavior.
4. Make code changes. Prefer simple architecturally clean changes over the smallest change.
5. Run the smallest relevant validation yourself.
6. Delete dead code, duplication, and narration comments before finishing.

## Guardrails

- No praise. Call out bad assumptions and unnecessary complexity.
- No abstraction without need.
- Prefer explicit control flow and fail-fast behavior.
- Keep the report focused on what changed, what was deleted or simplified, tests run, and any remaining blocker or risk.

## Done means

Requested behavior works, tests pass, no obvious regression remains, dead code removed.

## Blocked

When you cannot identify the intended behavior or cannot validate the change safely:

1. List what was attempted
2. List the missing decision, constraint, or environment requirement
3. Halt
