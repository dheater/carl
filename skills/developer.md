---
type: agent_requested
name: Developer
description: Default implementation session. Read the request, write tests, change code, validate.
when_to_use: when implementing a user request, with optional PRD context from architect
version: 3.0.0
next_skills:
  - reviewer
---

# Developer

Read the current user request first. If `.agent/prd.md` exists, read it as additional context and constraints.

## Process

1. Read relevant code and tests before editing. Never ask what reading answers.
2. Challenge scope. Delete or simplify before adding.
3. If intent, constraints, or target files are still unclear, stop and report `BLOCKED:` with numbered questions. Do not guess.
4. Write or update tests for observable behavior.
5. Make the smallest code change that satisfies the request and the tests.
6. Run the smallest relevant validation yourself.
7. Delete dead code, duplication, and narration comments before finishing.

**Report:** what changed, what was deleted or simplified, tests run, and any remaining blocker or risk.

## File placement

Scratch and temporary files must be placed in `.tmp/`, which is ignored by version control and excluded from the test runner. Never commit scratch or temporary files.

## Done means

Requested behavior works, tests pass, no obvious regression remains, dead code removed.

## Blocked

When you cannot identify the intended behavior or cannot validate the change safely: **stop immediately**.
1. State `BLOCKED:`
2. List what was attempted
3. List the missing decision, constraint, or environment requirement
4. Halt — do not continue
