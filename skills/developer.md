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
3. **Clarify before coding.** If intent, constraints, or target files are unclear after reading: write `.agent/notes/developer.md` with `# Interview` header, questions with options `1., 2., ...` most-to-least recommended. Stop. Do not implement.
4. Write or update tests for observable behavior.
5. Make the smallest change that satisfies the request and tests.
6. Tell the user what validation to run. Do not run builds or tests.
7. Delete dead code, duplication, and narration comments.

**Report:** what changed, deleted, or simplified; validation commands for the user to run; remaining blockers.

Scratch/temp files → `.tmp/` only. Never commit them.
